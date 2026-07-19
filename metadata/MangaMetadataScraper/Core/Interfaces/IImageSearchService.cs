using MangaMetadataScraper.Core.Models;

namespace MangaMetadataScraper.Core.Interfaces;

public interface IImageSearchService
{
    /// <summary>
    /// Tim cover + banner images theo ten manga (page 1).
    /// Tra ve ket qua va co the load them khong.
    /// </summary>
    Task<(List<ImageSearchResult> Results, bool HasNextPage)> SearchImagesAsync(
        string title,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Load them AniList page ke tiep.
    /// </summary>
    Task<(List<ImageSearchResult> Results, bool HasNextPage)> LoadMoreAniListAsync(
        string title,
        int page,
        CancellationToken cancellationToken = default);
}
