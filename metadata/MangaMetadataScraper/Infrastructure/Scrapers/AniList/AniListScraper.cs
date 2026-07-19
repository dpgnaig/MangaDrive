using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace MangaMetadataScraper.Infrastructure.Scrapers.AniList;

public class AniListScraper : IMangaScraper, IDisposable
{
    private readonly HttpClient _http;
    private readonly ILogger<AniListScraper> _logger;

    private const string ApiUrl    = "https://graphql.anilist.co";
    private const string DetailBase = "https://anilist.co/manga";

    public string SourceName => "AniList";

    public AniListScraper(ILogger<AniListScraper> logger)
    {
        _logger = logger;
        _http   = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.Add("User-Agent", "MangaMetadataScraper/1.0 (contact@example.com)");
        _http.DefaultRequestHeaders.Add("Accept", "application/json");
    }

    // --- Search --------------------------------------------------------------

    public async Task<List<SearchResultItem>> SearchAsync(
        string keyword,
        CancellationToken cancellationToken = default)
    {
        var results = new List<SearchResultItem>();
        try
        {
            const string query = """
                query ($search: String) {
                  Page(page: 1, perPage: 10) {
                    media(search: $search, type: MANGA) {
                      id
                      title { romaji english native }
                      coverImage { large medium }
                      staff(perPage: 4) {
                        edges { role node { name { full } } }
                      }
                    }
                  }
                }
                """;

            var json = await PostGraphQlAsync(query, new { search = keyword }, cancellationToken);
            if (string.IsNullOrEmpty(json)) return results;

            using var doc    = JsonDocument.Parse(json);
            var mediaArr = doc.RootElement
                .GetProperty("data")
                .GetProperty("Page")
                .GetProperty("media");

            foreach (var media in mediaArr.EnumerateArray())
            {
                var id = media.TryGetProperty("id", out var idEl)
                    ? idEl.GetInt32().ToString()
                    : string.Empty;
                if (string.IsNullOrEmpty(id)) continue;

                var title    = PickTitle(media.GetProperty("title"));
                var coverUrl = string.Empty;
                if (media.TryGetProperty("coverImage", out var ci))
                    coverUrl = TryStr(ci, "large") ?? TryStr(ci, "medium") ?? string.Empty;

                var author = ExtractAuthorFromSearch(media);

                results.Add(new SearchResultItem
                {
                    Title     = title,
                    CoverUrl  = coverUrl,
                    Source    = SourceName,
                    RawId     = id,
                    DetailUrl = $"{DetailBase}/{id}",
                    Slug      = author
                });
            }

            _logger.LogInformation("[AniList] Search '{Keyword}': {Count} ket qua", keyword, results.Count);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AniList] Loi search '{Keyword}'", keyword);
        }
        return results;
    }

    // --- GetMetadata ---------------------------------------------------------

    public async Task<MangaMetadata?> GetMetadataAsync(
        SearchResultItem item,
        CancellationToken cancellationToken = default)
    {
        if (!int.TryParse(item.RawId, out var mediaId)) return null;

        try
        {
            const string query = """
                query ($id: Int) {
                  Media(id: $id, type: MANGA) {
                    id
                    title { romaji english native }
                    description(asHtml: false)
                    status
                    format
                    coverImage { extraLarge large medium }
                    genres
                    tags { name category rank }
                    synonyms
                    staff(perPage: 10) {
                      edges { role node { name { full } } }
                    }
                  }
                }
                """;

            var json = await PostGraphQlAsync(query, new { id = mediaId }, cancellationToken);
            if (string.IsNullOrEmpty(json)) return null;

            using var doc  = JsonDocument.Parse(json);
            var media = doc.RootElement
                .GetProperty("data")
                .GetProperty("Media");

            // -- Titles -------------------------------------------------------
            var titleObj = media.GetProperty("title");
            var enTitle  = TryStr(titleObj, "english") ?? string.Empty;
            var roTitle  = TryStr(titleObj, "romaji")  ?? string.Empty;
            var jaTitle  = TryStr(titleObj, "native")  ?? string.Empty;

            var primary = !string.IsNullOrWhiteSpace(enTitle) ? enTitle
                        : !string.IsNullOrWhiteSpace(roTitle) ? roTitle
                        : jaTitle;

            var altParts = new List<string>();
            foreach (var t in new[] { enTitle, roTitle, jaTitle })
                if (!string.IsNullOrWhiteSpace(t) && t != primary)
                    altParts.Add(t);

            if (media.TryGetProperty("synonyms", out var syns) &&
                syns.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in syns.EnumerateArray())
                {
                    var sv = s.GetString() ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(sv) && !altParts.Contains(sv))
                        altParts.Add(sv);
                }
            }

            var searchTitles = new List<string>();
            foreach (var t in new[] { enTitle, roTitle, jaTitle })
                if (!string.IsNullOrWhiteSpace(t) && !searchTitles.Contains(t))
                    searchTitles.Add(t);

            // -- OtherTitles (with lang) --------------------------------------
            var otherTitles = new List<TitleEntry>();
            if (!string.IsNullOrWhiteSpace(jaTitle) && jaTitle != primary)
                otherTitles.Add(new TitleEntry { Lang = "ja", Title = jaTitle });
            if (!string.IsNullOrWhiteSpace(roTitle) && roTitle != primary)
                otherTitles.Add(new TitleEntry { Lang = "ja-ro", Title = roTitle });
            if (!string.IsNullOrWhiteSpace(enTitle) && enTitle != primary)
                otherTitles.Add(new TitleEntry { Lang = "en", Title = enTitle });
            // synonyms → lang unknown
            if (media.TryGetProperty("synonyms", out var synArr2) &&
                synArr2.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in synArr2.EnumerateArray())
                {
                    var sv = s.GetString() ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(sv) && sv != primary &&
                        !otherTitles.Exists(t => t.Title == sv))
                        otherTitles.Add(new TitleEntry { Lang = "", Title = sv });
                }
            }

            // -- Themes (from tags with "Theme" category, rank >= 60) ---------
            var themes = new List<string>();
            if (media.TryGetProperty("tags", out var tagsArr) &&
                tagsArr.ValueKind == JsonValueKind.Array)
            {
                foreach (var tag in tagsArr.EnumerateArray())
                {
                    var category = TryStr(tag, "category") ?? string.Empty;
                    var rank = tag.TryGetProperty("rank", out var rankEl) && rankEl.ValueKind == JsonValueKind.Number
                        ? rankEl.GetInt32()
                        : 0;
                    if (category.Contains("Theme", StringComparison.OrdinalIgnoreCase) && rank >= 60)
                    {
                        var tagName = TryStr(tag, "name") ?? string.Empty;
                        if (!string.IsNullOrWhiteSpace(tagName))
                            themes.Add(tagName);
                    }
                }
            }

            // -- Demographic (from tags first, fallback to format) -------------
            var demographic = ExtractDemographicFromTags(media);
            if (string.IsNullOrWhiteSpace(demographic))
                demographic = NormalizeDemographic(TryStr(media, "format") ?? string.Empty);

            // -- Cover --------------------------------------------------------
            var coverUrl = string.Empty;
            if (media.TryGetProperty("coverImage", out var coverImg))
                coverUrl = TryStr(coverImg, "extraLarge")
                        ?? TryStr(coverImg, "large")
                        ?? TryStr(coverImg, "medium")
                        ?? string.Empty;

            var coverUrls = new List<string>();
            if (!string.IsNullOrEmpty(coverUrl)) coverUrls.Add(coverUrl);

            // -- Staff --------------------------------------------------------
            ExtractStaff(media, out var author, out var artist);

            // -- Genres -------------------------------------------------------
            var genres = new List<string>();
            if (media.TryGetProperty("genres", out var genreArr) &&
                genreArr.ValueKind == JsonValueKind.Array)
            {
                foreach (var g in genreArr.EnumerateArray())
                {
                    var gv = g.GetString() ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(gv)) genres.Add(gv);
                }
            }

            // -- Description + Status -----------------------------------------
            var description = TryStr(media, "description") ?? string.Empty;
            var status      = NormalizeStatus(TryStr(media, "status") ?? string.Empty);

            _logger.LogInformation("[AniList] GetMetadata OK: '{Title}'", primary);

            return new MangaMetadata
            {
                Title            = primary,
                AlternativeTitle = string.Join(" / ", altParts),
                OtherTitles      = otherTitles,
                Description      = description,
                Author           = author,
                Artist           = artist,
                Genres           = genres,
                Themes           = themes,
                Demographic      = demographic,
                Status           = status,
                CoverUrl         = coverUrl,
                CoverUrls        = coverUrls,
                SearchTitles     = searchTitles,
                Source           = SourceName,
                DetailUrl        = !string.IsNullOrEmpty(item.DetailUrl)
                                   ? item.DetailUrl
                                   : $"{DetailBase}/{mediaId}"
            };
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AniList] Loi GetMetadata id={Id}", item.RawId);
            return null;
        }
    }

    // --- Helpers -------------------------------------------------------------

    private async Task<string> PostGraphQlAsync(
        string query, object variables, CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new { query, variables });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var resp    = await _http.PostAsync(ApiUrl, content, ct);
        if (!resp.IsSuccessStatusCode)
        {
            _logger.LogWarning("[AniList] HTTP {Status}", resp.StatusCode);
            return string.Empty;
        }
        return await resp.Content.ReadAsStringAsync(ct);
    }

    private static string PickTitle(JsonElement titleObj)
    {
        foreach (var lang in new[] { "english", "romaji", "native" })
        {
            var v = TryStr(titleObj, lang);
            if (!string.IsNullOrWhiteSpace(v)) return v;
        }
        return string.Empty;
    }

    private static string ExtractAuthorFromSearch(JsonElement media)
    {
        if (!media.TryGetProperty("staff", out var staff)) return string.Empty;
        if (!staff.TryGetProperty("edges", out var edges)) return string.Empty;
        foreach (var edge in edges.EnumerateArray())
        {
            var role = TryStr(edge, "role") ?? string.Empty;
            if (role.Contains("Story", StringComparison.OrdinalIgnoreCase) ||
                role.Contains("Original", StringComparison.OrdinalIgnoreCase))
            {
                if (edge.TryGetProperty("node", out var node) &&
                    node.TryGetProperty("name", out var name))
                    return TryStr(name, "full") ?? string.Empty;
            }
        }
        return string.Empty;
    }

    private static void ExtractStaff(JsonElement media, out string author, out string artist)
    {
        author = string.Empty;
        artist = string.Empty;
        if (!media.TryGetProperty("staff", out var staff)) return;
        if (!staff.TryGetProperty("edges", out var edges)) return;

        foreach (var edge in edges.EnumerateArray())
        {
            var role = TryStr(edge, "role") ?? string.Empty;
            if (!edge.TryGetProperty("node", out var node)) continue;
            if (!node.TryGetProperty("name", out var name)) continue;
            var full = TryStr(name, "full") ?? string.Empty;
            if (string.IsNullOrEmpty(full)) continue;

            if (string.IsNullOrEmpty(author) &&
                (role.Contains("Story", StringComparison.OrdinalIgnoreCase) ||
                 role.Contains("Original", StringComparison.OrdinalIgnoreCase)))
                author = full;

            if (string.IsNullOrEmpty(artist) &&
                role.Contains("Art", StringComparison.OrdinalIgnoreCase))
                artist = full;

            if (!string.IsNullOrEmpty(author) && !string.IsNullOrEmpty(artist)) break;
        }

        // Neu chi co 1 staff thi co the vua viet vua ve
        if (!string.IsNullOrEmpty(author) && string.IsNullOrEmpty(artist))
            artist = author;
    }

    private static string NormalizeStatus(string raw) => raw.ToUpperInvariant() switch
    {
        "FINISHED"         => "Completed",
        "RELEASING"        => "Ongoing",
        "NOT_YET_RELEASED" => "Upcoming",
        "CANCELLED"        => "Cancelled",
        "HIATUS"           => "Hiatus",
        _                  => raw
    };

    /// <summary>
    /// AniList format → demographic string.
    /// AniList không có demographic trực tiếp, nên ta dùng format (MANGA, NOVEL, ONE_SHOT...).
    /// Nếu tags có "Shounen", "Shoujo", "Seinen", "Josei" thì dùng tag đó.
    /// </summary>
    private static string NormalizeDemographic(string format) => format.ToUpperInvariant() switch
    {
        "MANGA"    => "Shounen",
        "NOVEL"    => "",
        "ONE_SHOT" => "",
        _          => ""
    };

    /// <summary>
    /// Trích xuất demographic từ tags (ưu tiên hơn format).
    /// </summary>
    private static string ExtractDemographicFromTags(JsonElement media)
    {
        if (!media.TryGetProperty("tags", out var tagsArr) ||
            tagsArr.ValueKind != JsonValueKind.Array)
            return string.Empty;

        var demographicNames = new[] { "Shounen", "Shoujo", "Seinen", "Josei" };

        foreach (var tag in tagsArr.EnumerateArray())
        {
            var name = TryStr(tag, "name") ?? string.Empty;
            if (demographicNames.Contains(name, StringComparer.OrdinalIgnoreCase))
                return name;
        }
        return string.Empty;
    }

    private static string? TryStr(JsonElement el, string prop)
    {
        if (el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String)
            return v.GetString();
        return null;
    }

    public void Dispose() => _http.Dispose();
}
