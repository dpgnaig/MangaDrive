using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace MangaMetadataScraper.Infrastructure.Scrapers.TruyenQQ;

public class TruyenQQScraper : BaseScraper
{
    private const string BaseUrl = "https://truyenqqko.com";

    public override string SourceName => "TruyenQQ";

    public TruyenQQScraper(
        IBrowserFactory browserFactory,
        ILogger<TruyenQQScraper> logger)
        : base(browserFactory, logger)
    { }

    // --- Search ---------------------------------------------------------------

    protected override async Task<List<SearchResultItem>> SearchCoreAsync(
        IPage page,
        string keyword,
        CancellationToken cancellationToken)
    {
        Logger.LogInformation("[{Source}] Truy cap homepage: {Url}", SourceName, BaseUrl);
        await page.GotoAsync(BaseUrl, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.Load,
            Timeout   = 30_000
        });

        await page.WaitForLoadStateAsync(LoadState.NetworkIdle,
            new PageWaitForLoadStateOptions { Timeout = 15_000 });

        var searchUrl = $"{BaseUrl}/tim-kiem?q={Uri.EscapeDataString(keyword)}";
        Logger.LogInformation("[{Source}] Search URL: {Url}", SourceName, searchUrl);

        await page.GotoAsync(searchUrl, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.Load,
            Timeout   = 30_000
        });

        try
        {
            await page.WaitForSelectorAsync(
                "ul.list_grid.grid > li, .no-result, .search-result-empty",
                new PageWaitForSelectorOptions { Timeout = 15_000 });
        }
        catch (TimeoutException)
        {
            Logger.LogWarning("[{Source}] Timeout cho selector ket qua search", SourceName);
        }

        return await ParseSearchListAsync(page);
    }

    // --- GetMetadata ----------------------------------------------------------

    protected override async Task<MangaMetadata?> GetMetadataCoreAsync(
        IPage page,
        SearchResultItem item,
        CancellationToken cancellationToken)
    {
        Logger.LogInformation("[{Source}] Mo detail: {Url}", SourceName, item.DetailUrl);

        await page.GotoAsync(item.DetailUrl, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.Load,
            Timeout   = 30_000
        });

        try
        {
            await page.WaitForSelectorAsync(
                ".book_other h1, .book_info .book_other",
                new PageWaitForSelectorOptions { Timeout = 15_000 });
        }
        catch (TimeoutException)
        {
            Logger.LogWarning("[{Source}] Timeout cho selector detail", SourceName);
        }

        return await ParseDetailAsync(page, item);
    }

    // --- Parse search list ----------------------------------------------------

    private async Task<List<SearchResultItem>> ParseSearchListAsync(IPage page)
    {
        var results = new List<SearchResultItem>();
        var liItems = await page.QuerySelectorAllAsync("ul.list_grid.grid > li");
        Logger.LogInformation("[{Source}] Tim thay {Count} li items", SourceName, liItems.Count);

        foreach (var li in liItems)
        {
            try
            {
                var linkEl = await li.QuerySelectorAsync(".book_avatar a");
                if (linkEl is null) continue;

                var href = await linkEl.GetAttributeAsync("href") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(href)) continue;
                var detailUrl = href.StartsWith("http") ? href : $"{BaseUrl}{href}";

                var imgEl = await li.QuerySelectorAsync(".book_avatar img");
                var cover = string.Empty;
                if (imgEl is not null)
                {
                    cover = await imgEl.GetAttributeAsync("src") ?? string.Empty;
                    if (string.IsNullOrEmpty(cover))
                        cover = await imgEl.GetAttributeAsync("data-fb") ?? string.Empty;
                }

                var titleEl = await li.QuerySelectorAsync(".book_name h3 a");
                var title = titleEl is not null
                    ? (await titleEl.GetAttributeAsync("title") ?? await titleEl.InnerTextAsync()).Trim()
                    : string.Empty;

                if (string.IsNullOrWhiteSpace(title)) continue;

                results.Add(new SearchResultItem
                {
                    Title     = title,
                    CoverUrl  = cover,
                    Source    = SourceName,
                    Slug      = href.TrimStart('/'),
                    DetailUrl = detailUrl,
                    RawId     = string.Empty
                });
            }
            catch (Exception ex)
            {
                Logger.LogDebug(ex, "[{Source}] Loi parse 1 search item", SourceName);
            }
        }

        Logger.LogInformation("[{Source}] Parse duoc {Count} ket qua", SourceName, results.Count);
        return results;
    }

    // --- Parse detail page ----------------------------------------------------

    private async Task<MangaMetadata?> ParseDetailAsync(IPage page, SearchResultItem item)
    {
        var title = await GetTextAsync(page, ".book_other h1[itemprop='name'], .book_other h1");
        if (string.IsNullOrEmpty(title)) title = item.Title;

        // AlternativeTitle: "Vua Hai Tac; One Piece; OP" (semicolon-separated)
        var altTitleRaw = await GetTextAsync(page, ".list-info li.othername .other-name");

        var cover   = await GetAttrAsync(page, ".book_avatar_wrapper .book_avatar img", "src");
        var coverFb = await GetAttrAsync(page, ".book_avatar_wrapper .book_avatar img", "data-fb");
        if (string.IsNullOrEmpty(cover)) cover = coverFb;
        if (string.IsNullOrEmpty(cover)) cover = item.CoverUrl;

        var coverUrls = new List<string>();
        foreach (var u in new[] { cover, coverFb, item.CoverUrl })
            if (!string.IsNullOrWhiteSpace(u) && !coverUrls.Contains(u)) coverUrls.Add(u);

        var author = await GetTextAsync(page, ".list-info li.author p.col-xs-9");
        var status = await GetTextAsync(page, ".list-info li.status p.col-xs-9");
        var artist = await GetTextAsync(page, ".list-info li.team p.col-xs-9");

        var genreEls = await page.QuerySelectorAllAsync(".book_other ul.list01 li.li03 a");
        var genres   = new List<string>();
        foreach (var el in genreEls)
        {
            var t = (await el.InnerTextAsync()).Trim();
            if (!string.IsNullOrWhiteSpace(t)) genres.Add(t);
        }

        var description = await GetTextAsync(page,
            ".story-detail-info, .story-detail div.story-detail-info, " +
            "div[itemprop='description'], .summary p");

        // -- SearchTitles: uu tien ten goc (en/ja) tu altTitleRaw -------------
        var searchTitles = BuildSearchTitles(title, altTitleRaw);

        Logger.LogInformation(
            "[{Source}] Parse detail OK: '{Title}', searchTitles={Titles}",
            SourceName, title, string.Join(" | ", searchTitles));

        return new MangaMetadata
        {
            Title            = title,
            AlternativeTitle = altTitleRaw,
            Description      = description,
            Author           = author,
            Artist           = artist,
            Genres           = genres,
            Status           = NormalizeStatus(status),
            CoverUrl         = cover,
            CoverUrls        = coverUrls,
            CoverImageBytes  = await FetchImageBytesAsync(page, cover, item.DetailUrl),
            SearchTitles     = searchTitles,
            Source           = SourceName,
            DetailUrl        = item.DetailUrl
        };
    }

    // --- SearchTitles builder -------------------------------------------------

    /// <summary>
    /// TruyenQQ khong co language tag — phan tich noi dung de sap xep.
    /// Thu tu: ten co ky tu Latin thuan (likely en/romaji) -> ten co ky tu Nhat ->
    ///         ten goc site -> cac ten con lai.
    /// </summary>
    private static List<string> BuildSearchTitles(string primaryTitle, string altTitleRaw)
    {
        // Tach cac ten tu altTitleRaw (ngan cach bang ; hoac ,)
        var allTitles = new List<string>();
        if (!string.IsNullOrWhiteSpace(altTitleRaw))
        {
            var parts = altTitleRaw.Split(new[] { ';', ',' },
                StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            allTitles.AddRange(parts);
        }

        var result = new List<string>();
        var seen   = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Add(string s)
        {
            if (!string.IsNullOrWhiteSpace(s) && seen.Add(s))
                result.Add(s);
        }

        // Nhom 1: co ky tu Latin thuan (en / romaji JP) — ko co ky tu CJK hay dau tieng Viet
        var latinTitles    = allTitles.Where(IsLikelyLatinTitle).ToList();
        // Nhom 2: co ky tu Nhat (Hiragana/Katakana/Kanji)
        var japaneseTitles = allTitles.Where(IsLikelyJapanese).ToList();
        // Con lai
        var otherTitles    = allTitles
            .Where(t => !IsLikelyLatinTitle(t) && !IsLikelyJapanese(t))
            .ToList();

        foreach (var t in latinTitles)    Add(t);
        foreach (var t in japaneseTitles) Add(t);

        // Ten goc tren site (co the la tieng Viet)
        Add(primaryTitle);

        foreach (var t in otherTitles) Add(t);

        return result;
    }

    /// <summary>Latin thuan: khong co ky tu Unicode > U+024F (CJK, dau tieng Viet...)</summary>
    private static bool IsLikelyLatinTitle(string s)
        => s.All(c => c <= '\u024F' || c == ' ' || c == '-' || c == ':' || c == '\'');

    /// <summary>Co it nhat 1 ky tu Hiragana, Katakana, hoac CJK Unified Ideograph.</summary>
    private static bool IsLikelyJapanese(string s)
        => s.Any(c => (c >= '\u3040' && c <= '\u309F') ||   // Hiragana
                      (c >= '\u30A0' && c <= '\u30FF') ||   // Katakana
                      (c >= '\u4E00' && c <= '\u9FFF'));     // CJK

    // --- Helpers --------------------------------------------------------------

    private static async Task<string> GetTextAsync(IPage page, string selector)
    {
        var el = await page.QuerySelectorAsync(selector);
        return el is null ? string.Empty : (await el.InnerTextAsync()).Trim();
    }

    private static async Task<string> GetAttrAsync(IPage page, string selector, string attr)
    {
        var el = await page.QuerySelectorAsync(selector);
        return el is null ? string.Empty : await el.GetAttributeAsync(attr) ?? string.Empty;
    }

    private static string NormalizeStatus(string raw) => raw.Trim().ToLowerInvariant() switch
    {
        "dang ra" or "dang cap nhat" or "ongoing"  => "Ongoing",
        "hoan thanh" or "hoan tat" or "completed"  => "Completed",
        "tam dung" or "hiatus"                     => "Hiatus",
        _                                           => raw.Trim()
    };
}
