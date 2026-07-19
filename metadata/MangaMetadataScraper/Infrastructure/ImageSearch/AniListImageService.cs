using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace MangaMetadataScraper.Infrastructure.ImageSearch;

public class AniListImageService : IDisposable
{
    private readonly HttpClient _http;
    private readonly ILogger<AniListImageService> _logger;

    private const string ApiUrl  = "https://graphql.anilist.co";
    private const int    PerPage = 20;

    public AniListImageService(ILogger<AniListImageService> logger)
    {
        _logger = logger;
        _http   = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.Add("User-Agent", "MangaMetadataScraper/1.0");
    }

    /// <summary>Page 1 — dung cho lan search dau tien.</summary>
    public Task<(List<ImageSearchResult> Results, bool HasNextPage)> SearchAsync(
        string title,
        CancellationToken cancellationToken = default)
        => SearchPageAsync(title, page: 1, cancellationToken);

    /// <summary>Co the goi voi page > 1 de load them.</summary>
    public async Task<(List<ImageSearchResult> Results, bool HasNextPage)> SearchPageAsync(
        string title,
        int page,
        CancellationToken cancellationToken = default)
    {
        var results = new List<ImageSearchResult>();
        var hasNextPage = false;
        try
        {
            const string query = """
                query ($search: String, $page: Int, $perPage: Int) {
                  Page(page: $page, perPage: $perPage) {
                    pageInfo { hasNextPage }
                    media(search: $search, type: MANGA) {
                      id
                      title { romaji english native }
                      coverImage { extraLarge medium }
                      bannerImage
                    }
                  }
                }
                """;

            var payload = JsonSerializer.Serialize(new
            {
                query,
                variables = new { search = title, page, perPage = PerPage }
            });

            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var resp    = await _http.PostAsync(ApiUrl, content, cancellationToken);

            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[AniList] HTTP {Status} page={Page}", resp.StatusCode, page);
                return (results, false);
            }

            var json = await resp.Content.ReadAsStringAsync(cancellationToken);
            using var doc = JsonDocument.Parse(json);

            var pageEl = doc.RootElement
                .GetProperty("data")
                .GetProperty("Page");

            // pageInfo
            if (pageEl.TryGetProperty("pageInfo", out var pageInfo) &&
                pageInfo.TryGetProperty("hasNextPage", out var hnp))
                hasNextPage = hnp.GetBoolean();

            var mediaArr = pageEl.GetProperty("media");
            var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var media in mediaArr.EnumerateArray())
            {
                var titleObj = media.GetProperty("title");
                var label = titleObj.TryGetProperty("english", out var en) &&
                            en.ValueKind == JsonValueKind.String &&
                            !string.IsNullOrWhiteSpace(en.GetString())
                    ? en.GetString()!
                    : titleObj.TryGetProperty("romaji", out var ro) &&
                      ro.ValueKind == JsonValueKind.String
                        ? ro.GetString() ?? string.Empty
                        : string.Empty;

                // Cover: chi lay extraLarge
                if (media.TryGetProperty("coverImage", out var coverImg))
                {
                    var mediumUrl = coverImg.TryGetProperty("medium", out var medEl) &&
                                    medEl.ValueKind == JsonValueKind.String
                        ? medEl.GetString() ?? string.Empty
                        : string.Empty;

                    if (coverImg.TryGetProperty("extraLarge", out var urlEl) &&
                        urlEl.ValueKind == JsonValueKind.String)
                    {
                        var url = urlEl.GetString() ?? string.Empty;
                        if (!string.IsNullOrWhiteSpace(url) && seenUrls.Add(url))
                        {
                            results.Add(new ImageSearchResult
                            {
                                Url      = url,
                                ThumbUrl = string.IsNullOrEmpty(mediumUrl) ? url : mediumUrl,
                                Source   = "AniList",
                                Type     = "cover",
                                Label    = $"{label} [AniList]"
                            });
                        }
                    }
                }

                // Banner
                if (media.TryGetProperty("bannerImage", out var bannerEl) &&
                    bannerEl.ValueKind == JsonValueKind.String)
                {
                    var bannerUrl = bannerEl.GetString() ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(bannerUrl) && seenUrls.Add(bannerUrl))
                    {
                        results.Add(new ImageSearchResult
                        {
                            Url      = bannerUrl,
                            ThumbUrl = bannerUrl,
                            Source   = "AniList",
                            Type     = "banner",
                            Label    = $"{label} [banner] [AniList]"
                        });
                    }
                }
            }

            _logger.LogInformation("[AniList] Page {Page}: {Count} item(s), hasNext={HasNext}",
                page, results.Count, hasNextPage);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AniList] Loi search page {Page}", page);
        }

        return (results, hasNextPage);
    }

    public void Dispose() => _http.Dispose();
}
