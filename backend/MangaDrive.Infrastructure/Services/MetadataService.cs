using System.Text;
using System.Text.Json;
using MangaDrive.Core.Interfaces;
using Microsoft.Extensions.Logging;

namespace MangaDrive.Infrastructure.Services;

/// <summary>
/// Fetches manga metadata from free external sources (AniList GraphQL, MangaDex REST).
/// Returns normalized <see cref="MetadataCandidate"/>s with external image URLs — the
/// caller stores those URLs directly (frontend serves absolute URLs as-is).
/// </summary>
public class MetadataService : IMetadataService
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<MetadataService> _logger;

    private const string AniListUrl = "https://graphql.anilist.co";
    private const string MangaDexApi = "https://api.mangadex.org";
    private const string MangaDexCovers = "https://uploads.mangadex.org/covers";
    private const string UserAgent = "MangaDrive/1.0 (contact@example.com)";

    public MetadataService(IHttpClientFactory httpFactory, ILogger<MetadataService> logger)
    {
        _httpFactory = httpFactory;
        _logger = logger;
    }

    public Task<List<MetadataCandidate>> SearchAsync(string source, string query, CancellationToken ct = default)
        => source.ToLowerInvariant() switch
        {
            "anilist" => SearchAniListAsync(query, ct),
            "mangadex" => SearchMangaDexAsync(query, ct),
            _ => Task.FromResult(new List<MetadataCandidate>())
        };

    private HttpClient NewClient()
    {
        var http = _httpFactory.CreateClient();
        http.Timeout = TimeSpan.FromSeconds(20);
        http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
        http.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");
        return http;
    }

    // ── AniList ──────────────────────────────────────────────────────────────

    private async Task<List<MetadataCandidate>> SearchAniListAsync(string query, CancellationToken ct)
    {
        var results = new List<MetadataCandidate>();
        try
        {
            const string gql = """
                query ($search: String) {
                  Page(page: 1, perPage: 25) {
                    media(search: $search, type: MANGA) {
                      id
                      title { romaji english native }
                      description(asHtml: false)
                      status
                      genres
                      synonyms
                      isAdult
                      coverImage { extraLarge large }
                      bannerImage
                      staff(perPage: 8) { edges { role node { name { full } } } }
                    }
                  }
                }
                """;
            var payload = JsonSerializer.Serialize(new { query = gql, variables = new { search = query } });
            using var http = NewClient();
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var resp = await http.PostAsync(AniListUrl, content, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[AniList] HTTP {Status}", resp.StatusCode);
                return results;
            }
            var json = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data)
                || !data.TryGetProperty("Page", out var pageEl)
                || !pageEl.TryGetProperty("media", out var mediaArr)
                || mediaArr.ValueKind != JsonValueKind.Array)
                return results;

            foreach (var media in mediaArr.EnumerateArray())
            {
                var id = media.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
                    ? idEl.GetInt32().ToString() : "";
                if (string.IsNullOrEmpty(id)) continue;

                var titleObj = media.GetProperty("title");
                var en = TryStr(titleObj, "english");
                var ro = TryStr(titleObj, "romaji");
                var ja = TryStr(titleObj, "native");
                var primary = FirstNonEmpty(en, ro, ja) ?? "(không tên)";

                var others = new List<MetadataTitle>();
                if (Filled(ja) && ja != primary) others.Add(new MetadataTitle("ja", ja!));
                if (Filled(ro) && ro != primary) others.Add(new MetadataTitle("ja-ro", ro!));
                if (Filled(en) && en != primary) others.Add(new MetadataTitle("en", en!));
                if (media.TryGetProperty("synonyms", out var syns) && syns.ValueKind == JsonValueKind.Array)
                    foreach (var s in syns.EnumerateArray())
                    {
                        var sv = s.GetString();
                        if (Filled(sv) && sv != primary && !others.Exists(o => o.Title == sv))
                            others.Add(new MetadataTitle("", sv!));
                    }

                var genres = new List<string>();
                if (media.TryGetProperty("genres", out var gArr) && gArr.ValueKind == JsonValueKind.Array)
                    foreach (var g in gArr.EnumerateArray())
                        if (Filled(g.GetString())) genres.Add(g.GetString()!);

                string cover = "";
                if (media.TryGetProperty("coverImage", out var ci))
                    cover = FirstNonEmpty(TryStr(ci, "extraLarge"), TryStr(ci, "large")) ?? "";

                results.Add(new MetadataCandidate(
                    Source: "AniList",
                    ExternalId: id,
                    Title: primary,
                    OtherTitles: others,
                    Description: TryStr(media, "description") ?? "",
                    Author: ExtractAuthor(media),
                    Status: NormalizeStatus(TryStr(media, "status") ?? ""),
                    Genres: genres,
                    CoverUrl: string.IsNullOrEmpty(cover) ? null : cover,
                    BannerUrl: TryStr(media, "bannerImage"),
                    DetailUrl: $"https://anilist.co/manga/{id}",
                    IsNSFW: TryBool(media, "isAdult")
                ));
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { _logger.LogError(ex, "[AniList] search failed for '{Q}'", query); }
        return results;
    }

    private static string ExtractAuthor(JsonElement media)
    {
        if (!media.TryGetProperty("staff", out var staff) || !staff.TryGetProperty("edges", out var edges))
            return "";
        string author = "", artist = "";
        foreach (var edge in edges.EnumerateArray())
        {
            var role = TryStr(edge, "role") ?? "";
            if (!edge.TryGetProperty("node", out var node) || !node.TryGetProperty("name", out var name)) continue;
            var full = TryStr(name, "full") ?? "";
            if (string.IsNullOrEmpty(full)) continue;
            if (string.IsNullOrEmpty(author) && (role.Contains("Story", StringComparison.OrdinalIgnoreCase) || role.Contains("Original", StringComparison.OrdinalIgnoreCase)))
                author = full;
            else if (string.IsNullOrEmpty(artist) && role.Contains("Art", StringComparison.OrdinalIgnoreCase))
                artist = full;
        }
        if (Filled(author) && Filled(artist) && author != artist) return $"{author} / {artist}";
        return FirstNonEmpty(author, artist) ?? "";
    }

    private static string NormalizeStatus(string raw) => raw.ToUpperInvariant() switch
    {
        "FINISHED" => "completed",
        "RELEASING" => "ongoing",
        "HIATUS" => "hiatus",
        "CANCELLED" => "cancelled",
        _ => raw.ToLowerInvariant()
    };

    // MangaDex's contentRating is a tri-state-ish enum, not a plain bool — map it onto
    // the same null=unknown/true=NSFW/false=safe semantics as AniList's isAdult.
    private static bool? NormalizeContentRating(string? raw) => raw?.ToLowerInvariant() switch
    {
        "safe" => false,
        "suggestive" or "erotica" or "pornographic" => true,
        _ => null
    };

    // ── MangaDex ─────────────────────────────────────────────────────────────

    private async Task<List<MetadataCandidate>> SearchMangaDexAsync(string query, CancellationToken ct)
    {
        var results = new List<MetadataCandidate>();
        try
        {
            var qs = new List<string>
            {
                "title=" + Uri.EscapeDataString(query),
                "limit=25",
                "includes[]=cover_art",
                "includes[]=author",
                "includes[]=artist",
                "contentRating[]=safe", "contentRating[]=suggestive", "contentRating[]=erotica"
            };
            var url = $"{MangaDexApi}/manga?" + string.Join("&", qs);
            using var http = NewClient();
            using var resp = await http.GetAsync(url, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[MangaDex] HTTP {Status}", resp.StatusCode);
                return results;
            }
            var json = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var dataArr) || dataArr.ValueKind != JsonValueKind.Array)
                return results;

            foreach (var m in dataArr.EnumerateArray())
            {
                var id = TryStr(m, "id");
                if (!Filled(id)) continue;
                if (!m.TryGetProperty("attributes", out var attrs)) continue;

                // Title: prefer en → ja-ro → first
                var primary = PickMdTitle(attrs);
                var others = new List<MetadataTitle>();
                if (attrs.TryGetProperty("altTitles", out var altArr) && altArr.ValueKind == JsonValueKind.Array)
                    foreach (var alt in altArr.EnumerateArray())
                        foreach (var p in alt.EnumerateObject())
                        {
                            var tv = p.Value.GetString();
                            if (Filled(tv) && tv != primary && !others.Exists(o => o.Title == tv))
                                others.Add(new MetadataTitle(p.Name, tv!));
                        }

                var desc = "";
                if (attrs.TryGetProperty("description", out var descObj) && descObj.ValueKind == JsonValueKind.Object)
                    desc = TryStr(descObj, "en") ?? FirstObjString(descObj) ?? "";

                var status = NormalizeStatus(TryStr(attrs, "status") ?? "");

                var genres = new List<string>();
                if (attrs.TryGetProperty("tags", out var tagArr) && tagArr.ValueKind == JsonValueKind.Array)
                    foreach (var tag in tagArr.EnumerateArray())
                        if (tag.TryGetProperty("attributes", out var ta)
                            && (TryStr(ta, "group") == "genre")
                            && ta.TryGetProperty("name", out var nm))
                        {
                            var gv = TryStr(nm, "en") ?? FirstObjString(nm);
                            if (Filled(gv)) genres.Add(gv!);
                        }

                // Cover + author from relationships (includes[])
                string? coverUrl = null, author = null;
                var authors = new List<string>();
                if (m.TryGetProperty("relationships", out var rels) && rels.ValueKind == JsonValueKind.Array)
                    foreach (var rel in rels.EnumerateArray())
                    {
                        var type = TryStr(rel, "type");
                        if (!rel.TryGetProperty("attributes", out var ra)) continue;
                        if (type == "cover_art")
                        {
                            var fn = TryStr(ra, "fileName");
                            if (Filled(fn)) coverUrl = $"{MangaDexCovers}/{id}/{fn}";
                        }
                        else if (type is "author" or "artist")
                        {
                            var nm = TryStr(ra, "name");
                            if (Filled(nm) && !authors.Contains(nm!)) authors.Add(nm!);
                        }
                    }
                if (authors.Count > 0) author = string.Join(" / ", authors);

                results.Add(new MetadataCandidate(
                    Source: "MangaDex",
                    ExternalId: id!,
                    Title: primary,
                    OtherTitles: others,
                    Description: desc,
                    Author: author ?? "",
                    Status: status,
                    Genres: genres,
                    CoverUrl: coverUrl,
                    BannerUrl: null,
                    DetailUrl: $"https://mangadex.org/title/{id}",
                    IsNSFW: NormalizeContentRating(TryStr(attrs, "contentRating"))
                ));
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { _logger.LogError(ex, "[MangaDex] search failed for '{Q}'", query); }
        return results;
    }

    private static string PickMdTitle(JsonElement attrs)
    {
        if (attrs.TryGetProperty("title", out var titleObj) && titleObj.ValueKind == JsonValueKind.Object)
        {
            foreach (var lang in new[] { "en", "ja-ro", "ja", "zh", "ko" })
            {
                var v = TryStr(titleObj, lang);
                if (Filled(v)) return v!;
            }
            var first = FirstObjString(titleObj);
            if (Filled(first)) return first!;
        }
        return "(không tên)";
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static string? TryStr(JsonElement el, string prop)
        => el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool? TryBool(JsonElement el, string prop)
        => el.TryGetProperty(prop, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)
            ? v.GetBoolean() : null;

    private static string? FirstObjString(JsonElement obj)
    {
        foreach (var p in obj.EnumerateObject())
            if (p.Value.ValueKind == JsonValueKind.String) return p.Value.GetString();
        return null;
    }

    private static bool Filled(string? s) => !string.IsNullOrWhiteSpace(s);

    private static string? FirstNonEmpty(params string?[] values)
        => values.FirstOrDefault(Filled);
}
