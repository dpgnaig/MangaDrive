using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using System.Net.Http;
using System.Text.Json;

namespace MangaMetadataScraper.Infrastructure.ImageSearch;

public class MangaDexImageService : IDisposable
{
    private readonly HttpClient _http;
    private readonly ILogger<MangaDexImageService> _logger;

    private const string ApiBase    = "https://api.mangadex.org";
    private const string CoversBase = "https://uploads.mangadex.org/covers";

    public MangaDexImageService(ILogger<MangaDexImageService> logger)
    {
        _logger = logger;
        _http   = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        // MangaDex yêu cầu User-Agent có format rõ ràng
        _http.DefaultRequestHeaders.TryAddWithoutValidation(
            "User-Agent", "MangaMetadataScraper/1.0 (contact@example.com)");
        _http.DefaultRequestHeaders.TryAddWithoutValidation(
            "Accept", "application/json");
    }

    public async Task<List<ImageSearchResult>> SearchAsync(
        string title,
        CancellationToken cancellationToken = default)
    {
        var results = new List<ImageSearchResult>();
        try
        {
            // ── Bước 1: tìm manga — dùng UriBuilder + QueryString để tránh
            //   [] bị encode thành %5B%5D trên một số HttpClient versions ──
            var qs = new List<string>
            {
                "title="            + Uri.EscapeDataString(title),
                "limit=5",
                "includes[]=cover_art",
                "contentRating[]=safe",
                "contentRating[]=suggestive",
                "contentRating[]=erotica",
                "contentRating[]=pornographic"
            };
            var searchUrl = $"{ApiBase}/manga?" + string.Join("&", qs);

            _logger.LogInformation("[MangaDex] Search URL: {Url}", searchUrl);

            using var resp = await _http.GetAsync(searchUrl, cancellationToken);
            var rawJson = await resp.Content.ReadAsStringAsync(cancellationToken);

            _logger.LogDebug("[MangaDex] HTTP {Status}, body length={Len}",
                resp.StatusCode, rawJson.Length);

            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[MangaDex] HTTP {Status}: {Body}",
                    resp.StatusCode, rawJson.Length > 300 ? rawJson[..300] : rawJson);
                return results;
            }

            if (string.IsNullOrWhiteSpace(rawJson))
            {
                _logger.LogWarning("[MangaDex] Response body rỗng");
                return results;
            }

            using var doc = JsonDocument.Parse(rawJson);
            var root = doc.RootElement;

            if (!root.TryGetProperty("data", out var dataArr) ||
                dataArr.ValueKind != JsonValueKind.Array)
            {
                _logger.LogWarning("[MangaDex] Không có 'data' array. result={Result}",
                    root.TryGetProperty("result", out var res) ? res.GetString() : "?");
                return results;
            }

            _logger.LogInformation("[MangaDex] Nhận được {Count} manga", dataArr.GetArrayLength());

            foreach (var manga in dataArr.EnumerateArray())
            {
                var mangaId = manga.TryGetProperty("id", out var idEl)
                    ? idEl.GetString() ?? string.Empty
                    : string.Empty;

                if (string.IsNullOrEmpty(mangaId)) continue;

                var titleDisplay = ExtractTitle(manga);

                // ── Bước 2: lấy cover_art từ relationships ──────────────
                var coverFileNames = ExtractCoverFileNamesFromRelationships(manga, mangaId);

                if (coverFileNames.Count == 0)
                {
                    // Fallback: gọi /cover?manga[]= nếu includes không trả về attributes
                    _logger.LogDebug("[MangaDex] manga {Id} không có cover trong relationships, gọi /cover API", mangaId);
                    coverFileNames = await FetchCoverFileNamesAsync(mangaId, cancellationToken);
                }

                foreach (var fileName in coverFileNames)
                {
                    results.Add(new ImageSearchResult
                    {
                        Url      = $"{CoversBase}/{mangaId}/{fileName}",
                        ThumbUrl = $"{CoversBase}/{mangaId}/{fileName}.256.jpg",
                        Source   = "MangaDex",
                        Type     = "cover",
                        Label    = $"{titleDisplay} [MangaDex]"
                    });
                }
            }

            _logger.LogInformation("[MangaDex] Tổng {Count} cover(s)", results.Count);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MangaDex] Lỗi search images");
        }

        return results;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string ExtractTitle(JsonElement manga)
    {
        if (!manga.TryGetProperty("attributes", out var attrs)) return string.Empty;
        if (!attrs.TryGetProperty("title", out var titleObj)) return string.Empty;

        // Ưu tiên: en → ja-ro → first available
        foreach (var lang in new[] { "en", "ja-ro", "zh", "ko" })
        {
            if (titleObj.TryGetProperty(lang, out var t) &&
                t.ValueKind == JsonValueKind.String)
                return t.GetString() ?? string.Empty;
        }

        foreach (var t in titleObj.EnumerateObject())
            return t.Value.GetString() ?? string.Empty;

        return string.Empty;
    }

    private static List<string> ExtractCoverFileNamesFromRelationships(
        JsonElement manga, string mangaId)
    {
        var files = new List<string>();
        if (!manga.TryGetProperty("relationships", out var rels)) return files;

        foreach (var rel in rels.EnumerateArray())
        {
            if (!rel.TryGetProperty("type", out var typeEl) ||
                typeEl.GetString() != "cover_art") continue;

            // attributes chỉ có khi includes[]=cover_art được server honour
            if (!rel.TryGetProperty("attributes", out var relAttrs)) continue;

            if (relAttrs.TryGetProperty("fileName", out var fn) &&
                fn.ValueKind == JsonValueKind.String)
            {
                var name = fn.GetString() ?? string.Empty;
                if (!string.IsNullOrEmpty(name))
                    files.Add(name);
            }
        }
        return files;
    }

    /// <summary>Fallback: gọi /cover?manga[]=id&limit=1 để lấy fileName.</summary>
    private async Task<List<string>> FetchCoverFileNamesAsync(
        string mangaId,
        CancellationToken cancellationToken)
    {
        var files = new List<string>();
        try
        {
            var url = $"{ApiBase}/cover?manga[]={mangaId}&limit=1&order[volume]=desc";
            using var resp = await _http.GetAsync(url, cancellationToken);
            var json = await resp.Content.ReadAsStringAsync(cancellationToken);

            if (!resp.IsSuccessStatusCode || string.IsNullOrWhiteSpace(json))
                return files;

            using var doc  = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var arr) ||
                arr.ValueKind != JsonValueKind.Array) return files;

            foreach (var item in arr.EnumerateArray())
            {
                if (!item.TryGetProperty("attributes", out var attrs)) continue;
                if (!attrs.TryGetProperty("fileName",  out var fn))    continue;
                var name = fn.GetString() ?? string.Empty;
                if (!string.IsNullOrEmpty(name))
                    files.Add(name);
            }

            _logger.LogDebug("[MangaDex] /cover fallback cho {Id}: {Count} file(s)", mangaId, files.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MangaDex] /cover fallback thất bại cho {Id}", mangaId);
        }
        return files;
    }

    public void Dispose() => _http.Dispose();
}
