using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;
using System.Text.Json;

namespace MangaMetadataScraper.Infrastructure.Scrapers.CuuTruyen;

public class CuuTruyenScraper : BaseScraper
{
    private const string BaseUrl        = "https://cuutruyen.net";
    private const string ApiQuickSearch = "https://cuutruyen.net/api/v2/mangas/quick_search?q={0}";
    private const string ApiMangaDetail = "https://cuutruyen.net/api/v2/mangas/{0}";
    private const string ProfileKey     = "cuutruyen";
    private const string Username       = "dpgnaig";
    private const string Password       = "Giangtez@123";

    public override string SourceName => "CuuTruyen";

    public CuuTruyenScraper(
        IBrowserFactory browserFactory,
        ILogger<CuuTruyenScraper> logger)
        : base(browserFactory, logger)
    { }

    // --- Persistent context ---------------------------------------------------

    protected override async Task<(IBrowserContext context, bool ownsContext)> GetContextAsync(
        CancellationToken cancellationToken)
    {
        var context = await BrowserFactory.GetPersistentContextAsync(ProfileKey, cancellationToken);
        return (context, ownsContext: false);
    }

    // --- Search ---------------------------------------------------------------

    protected override async Task<List<SearchResultItem>> SearchCoreAsync(
        IPage page,
        string keyword,
        CancellationToken cancellationToken)
    {
        await EnsureLoggedInAsync(page, cancellationToken);

        var apiUrl = string.Format(ApiQuickSearch, Uri.EscapeDataString(keyword));
        Logger.LogInformation("[{Source}] quick_search: {Url}", SourceName, apiUrl);

        var json = await FetchApiJsonAsync(page, apiUrl,
            url => url.Contains("/api/v2/mangas/quick_search", StringComparison.OrdinalIgnoreCase));

        return ParseSearchList(json);
    }

    // --- GetMetadata ----------------------------------------------------------

    protected override async Task<MangaMetadata?> GetMetadataCoreAsync(
        IPage page,
        SearchResultItem item,
        CancellationToken cancellationToken)
    {
        await EnsureLoggedInAsync(page, cancellationToken);

        if (string.IsNullOrWhiteSpace(item.RawId))
        {
            Logger.LogWarning("[{Source}] Khong co RawId", SourceName);
            return null;
        }

        var apiUrl = string.Format(ApiMangaDetail, item.RawId);
        Logger.LogInformation("[{Source}] detail API: {Url}", SourceName, apiUrl);

        var json = await FetchApiJsonAsync(page, apiUrl,
            url => url.Contains($"/api/v2/mangas/{item.RawId}", StringComparison.OrdinalIgnoreCase));

        var metadata = ParseDetailApi(json, item);
        if (metadata is null) return null;

        if (!string.IsNullOrWhiteSpace(metadata.CoverUrl))
        {
            try
            {
                await page.GotoAsync(metadata.DetailUrl, new PageGotoOptions
                {
                    WaitUntil = WaitUntilState.Load,
                    Timeout   = 20_000
                });
            }
            catch { /* ignore */ }

            metadata.CoverImageBytes = await FetchImageBytesAsync(page, metadata.CoverUrl, metadata.DetailUrl);
            Logger.LogInformation("[{Source}] Cover bytes: {Size}",
                SourceName, metadata.CoverImageBytes?.Length ?? 0);
        }

        return metadata;
    }

    // --- Login ----------------------------------------------------------------

    private async Task EnsureLoggedInAsync(IPage page, CancellationToken cancellationToken)
    {
        await page.GotoAsync(BaseUrl, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout   = 30_000
        });

        if (!page.Url.Contains("/login", StringComparison.OrdinalIgnoreCase))
        {
            Logger.LogInformation("[{Source}] Session hop le.", SourceName);
            return;
        }

        Logger.LogInformation("[{Source}] Phat hien trang login, dang dang nhap...", SourceName);

        await page.WaitForSelectorAsync("#username", new PageWaitForSelectorOptions
        {
            State   = WaitForSelectorState.Visible,
            Timeout = 15_000
        });

        await page.FillAsync("#username", Username);
        await page.FillAsync("#password", Password);

        await Task.WhenAll(
            page.WaitForURLAsync(
                url => !url.Contains("/login", StringComparison.OrdinalIgnoreCase),
                new PageWaitForURLOptions { Timeout = 30_000 }),
            page.PressAsync("#password", "Enter"));

        await page.WaitForLoadStateAsync(LoadState.NetworkIdle);
        Logger.LogInformation("[{Source}] Dang nhap thanh cong: {Url}", SourceName, page.Url);
    }

    // --- Fetch API helper -----------------------------------------------------

    private async Task<string> FetchApiJsonAsync(
        IPage page,
        string apiUrl,
        Func<string, bool> urlPredicate)
    {
        IResponse? captured = null;

        void OnResponse(object? _, IResponse resp)
        {
            if (urlPredicate(resp.Url))
                captured = resp;
        }

        page.Response += OnResponse;
        try
        {
            await page.GotoAsync(apiUrl, new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout   = 20_000
            });
        }
        finally
        {
            page.Response -= OnResponse;
        }

        if (captured is not null)
            return await captured.TextAsync();

        var bodyText = await page.InnerTextAsync("pre, body");
        return bodyText;
    }

    // --- Parse quick_search list ----------------------------------------------

    private List<SearchResultItem> ParseSearchList(string json)
    {
        var results = new List<SearchResultItem>();
        try
        {
            using var doc  = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("data", out var arr) || arr.ValueKind != JsonValueKind.Array)
            {
                Logger.LogWarning("[{Source}] quick_search JSON khong co 'data' array", SourceName);
                return results;
            }

            foreach (var item in arr.EnumerateArray())
            {
                var rawId      = item.TryGetProperty("id", out var idEl) ? idEl.ToString() : string.Empty;
                var title      = TryGetString(item, "name")        ?? string.Empty;
                var authorName = TryGetString(item, "author_name") ?? string.Empty;
                var coverUrl   = TryGetString(item, "cover_url")   ?? string.Empty;

                if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(rawId))
                    continue;

                results.Add(new SearchResultItem
                {
                    Title     = title,
                    CoverUrl  = coverUrl,
                    Source    = SourceName,
                    RawId     = rawId,
                    DetailUrl = $"{BaseUrl}/mangas/{rawId}",
                    Slug      = authorName
                });
            }

            Logger.LogInformation("[{Source}] Parse duoc {Count} ket qua", SourceName, results.Count);
        }
        catch (JsonException ex)
        {
            Logger.LogWarning(ex, "[{Source}] Parse quick_search JSON that bai", SourceName);
        }
        return results;
    }

    // --- Parse /api/v2/mangas/{id} --------------------------------------------

    private MangaMetadata? ParseDetailApi(string json, SearchResultItem item)
    {
        try
        {
            using var doc  = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            {
                Logger.LogWarning("[{Source}] detail API JSON khong co 'data' object", SourceName);
                return null;
            }

            // -- Title & Alternative titles -----------------------------------
            var primaryTitle = TryGetString(data, "name") ?? item.Title;
            var altTitles    = new List<string>();

            // lang -> name map de build SearchTitles
            var titlesByLang = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            if (data.TryGetProperty("titles", out var titlesArr) &&
                titlesArr.ValueKind == JsonValueKind.Array)
            {
                foreach (var t in titlesArr.EnumerateArray())
                {
                    var tName     = TryGetString(t, "name")     ?? string.Empty;
                    var tLang     = TryGetString(t, "language") ?? string.Empty; // "en", "ja", "vi", ...
                    var isPrimary = t.TryGetProperty("primary", out var pEl) && pEl.GetBoolean();

                    if (string.IsNullOrWhiteSpace(tName)) continue;

                    if (!string.IsNullOrWhiteSpace(tLang))
                        titlesByLang.TryAdd(tLang, tName);

                    if (!isPrimary &&
                        !tName.Equals(primaryTitle, StringComparison.OrdinalIgnoreCase))
                        altTitles.Add(tName);
                }
            }

            // SearchTitles: en -> ja -> primaryTitle (dedup)
            var searchTitles = BuildSearchTitles(titlesByLang, primaryTitle);

            // -- Author -------------------------------------------------------
            var author = string.Empty;
            if (data.TryGetProperty("author", out var authorEl) &&
                authorEl.ValueKind == JsonValueKind.Object)
                author = TryGetString(authorEl, "name") ?? string.Empty;

            if (string.IsNullOrEmpty(author))
                author = item.Slug;

            // -- Description --------------------------------------------------
            var description = TryGetString(data, "description") ?? string.Empty;

            // -- Cover --------------------------------------------------------
            var coverUrl       = TryGetString(data, "cover_url")        ?? item.CoverUrl;
            var coverMobileUrl = TryGetString(data, "cover_mobile_url") ?? string.Empty;
            var panoramaUrl    = TryGetString(data, "panorama_url")     ?? string.Empty;

            var coverUrls = new List<string>();
            foreach (var u in new[] { coverUrl, coverMobileUrl, panoramaUrl })
                if (!string.IsNullOrWhiteSpace(u)) coverUrls.Add(u);

            // -- Genres -------------------------------------------------------
            var genres = new List<string>();
            if (data.TryGetProperty("tags", out var tagsArr) &&
                tagsArr.ValueKind == JsonValueKind.Array)
            {
                foreach (var tag in tagsArr.EnumerateArray())
                {
                    var tagName = TryGetString(tag, "name") ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(tagName))
                        genres.Add(tagName);
                }
            }

            // -- Status -------------------------------------------------------
            var status = string.Empty;
            if (data.TryGetProperty("is_region_limited", out _))
            {
                status = data.TryGetProperty("newest_chapter_number", out var chEl) &&
                         chEl.ValueKind != JsonValueKind.Null
                    ? "Ongoing"
                    : string.Empty;
            }

            // -- DetailUrl ----------------------------------------------------
            var detailUrl = item.DetailUrl;
            if (string.IsNullOrEmpty(detailUrl))
                detailUrl = $"{BaseUrl}/mangas/{item.RawId}";

            Logger.LogInformation(
                "[{Source}] Parse detail OK: '{Title}', searchTitles={Titles}",
                SourceName, primaryTitle, string.Join(" | ", searchTitles));

            return new MangaMetadata
            {
                Title            = primaryTitle,
                AlternativeTitle = string.Join(" / ", altTitles),
                Description      = description,
                Author           = author,
                Artist           = string.Empty,
                Genres           = genres,
                Status           = status,
                CoverUrl         = coverUrl,
                CoverUrls        = coverUrls,
                SearchTitles     = searchTitles,
                Source           = SourceName,
                DetailUrl        = detailUrl
            };
        }
        catch (JsonException ex)
        {
            Logger.LogWarning(ex, "[{Source}] Parse detail API JSON that bai", SourceName);
            return null;
        }
    }

    // --- Helpers --------------------------------------------------------------

    /// <summary>
    /// Build danh sach SearchTitles theo thu tu uu tien: en -> ja -> primary.
    /// Dedup case-insensitive.
    /// </summary>
    private static List<string> BuildSearchTitles(
        Dictionary<string, string> titlesByLang,
        string primaryTitle)
    {
        var result = new List<string>();
        var seen   = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Add(string s)
        {
            if (!string.IsNullOrWhiteSpace(s) && seen.Add(s))
                result.Add(s);
        }

        // Thu tu uu tien: English -> Japanese -> primary
        foreach (var lang in new[] { "en", "ja", "ja-ro" })
        {
            if (titlesByLang.TryGetValue(lang, out var t))
                Add(t);
        }

        // Primary title as fallback
        Add(primaryTitle);

        // Cac ngon ngu con lai
        foreach (var kv in titlesByLang)
            Add(kv.Value);

        return result;
    }

    private static string? TryGetString(JsonElement el, string prop)
    {
        if (el.TryGetProperty(prop, out var val) && val.ValueKind == JsonValueKind.String)
            return val.GetString();
        return null;
    }
}
