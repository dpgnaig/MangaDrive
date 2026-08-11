namespace MangaDrive.Core.Interfaces;

/// <summary>One alternative title with an optional language tag.</summary>
public record MetadataTitle(string Lang, string Title);

/// <summary>
/// A single metadata match fetched from an external source (AniList / MangaDex).
/// Carries everything needed to apply it to a Manga, including external image URLs.
/// </summary>
public record MetadataCandidate(
    string Source,
    string ExternalId,
    string Title,
    List<MetadataTitle> OtherTitles,
    string Description,
    string Author,
    string Status,
    List<string> Genres,
    string? CoverUrl,
    string? BannerUrl,
    string? DetailUrl,
    bool? IsNSFW = null
);

public interface IMetadataService
{
    /// <summary>Search a source ("anilist" | "mangadex") by title; returns ranked candidates.</summary>
    Task<List<MetadataCandidate>> SearchAsync(string source, string query, CancellationToken ct = default);
}
