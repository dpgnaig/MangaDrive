using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;

namespace MangaMetadataScraper.Infrastructure.ImageSearch;

public class CombinedImageSearchService : IImageSearchService, IDisposable
{
    private readonly MangaDexImageService  _mangaDex;
    private readonly AniListImageService   _aniList;
    private readonly ILogger<CombinedImageSearchService> _logger;

    public CombinedImageSearchService(
        MangaDexImageService mangaDex,
        AniListImageService  aniList,
        ILogger<CombinedImageSearchService> logger)
    {
        _mangaDex = mangaDex;
        _aniList  = aniList;
        _logger   = logger;
    }

    public async Task<(List<ImageSearchResult> Results, bool HasNextPage)> SearchImagesAsync(
        string title,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("[ImageSearch] Tim anh cho: '{Title}'", title);

        var mangaDexTask = _mangaDex.SearchAsync(title, cancellationToken);
        var aniListTask  = _aniList.SearchAsync(title, cancellationToken);

        await Task.WhenAll(mangaDexTask, aniListTask);

        var (aniListResults, hasNextPage) = await aniListTask;

        var combined = new List<ImageSearchResult>();
        combined.AddRange(await mangaDexTask);
        combined.AddRange(aniListResults);

        _logger.LogInformation("[ImageSearch] Tong {Count} anh ({Covers} cover, {Banners} banner), hasNext={HasNext}",
            combined.Count,
            combined.Count(r => r.Type == "cover"),
            combined.Count(r => r.Type == "banner"),
            hasNextPage);

        return (combined, hasNextPage);
    }

    public async Task<(List<ImageSearchResult> Results, bool HasNextPage)> LoadMoreAniListAsync(
        string title,
        int page,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("[ImageSearch] Load them AniList page {Page} cho '{Title}'", page, title);
        return await _aniList.SearchPageAsync(title, page, cancellationToken);
    }

    public void Dispose()
    {
        _mangaDex.Dispose();
        _aniList.Dispose();
    }
}
