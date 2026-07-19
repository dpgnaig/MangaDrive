using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;

namespace MangaMetadataScraper.Core.Services;

public class SearchService : ISearchService
{
    private readonly IEnumerable<IMangaScraper> _scrapers;
    private readonly ILogger<SearchService> _logger;

    public SearchService(
        IEnumerable<IMangaScraper> scrapers,
        ILogger<SearchService> logger)
    {
        _scrapers = scrapers;
        _logger = logger;
    }

    /// <summary>
    /// Search song song tất cả scrapers cùng lúc.
    /// Gộp toàn bộ kết quả — không bỏ sót site nào, không bỏ sót item nào.
    /// </summary>
    public async Task<List<SearchResultItem>> SearchAllAsync(
        string keyword,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("SearchAll bắt đầu với keyword: '{Keyword}'", keyword);

        // Chạy song song tất cả scrapers
        var tasks = _scrapers.Select(scraper => SearchOneScraper(scraper, keyword, cancellationToken));
        var results = await Task.WhenAll(tasks);

        // Gộp theo thứ tự scraper đăng ký trong DI
        var combined = results
            .SelectMany(list => list)
            .ToList();

        _logger.LogInformation(
            "SearchAll hoàn tất: {Total} kết quả từ {Sites} site(s)",
            combined.Count,
            results.Count(r => r.Count > 0));

        return combined;
    }

    private async Task<List<SearchResultItem>> SearchOneScraper(
        IMangaScraper scraper,
        string keyword,
        CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Đang search trên: {Source}", scraper.SourceName);
            var items = await scraper.SearchAsync(keyword, cancellationToken);

            _logger.LogInformation(
                "[{Source}] Trả về {Count} kết quả",
                scraper.SourceName, items.Count);

            return items;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "[{Source}] Lỗi khi search: {Message}",
                scraper.SourceName, ex.Message);
            return [];
        }
    }

    /// <summary>
    /// Route về đúng scraper dựa theo item.Source, rồi gọi GetMetadataAsync.
    /// </summary>
    public async Task<MangaMetadata?> GetMetadataAsync(
        SearchResultItem item,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation(
            "Lấy metadata: '{Title}' từ {Source}", item.Title, item.Source);

        var scraper = _scrapers.FirstOrDefault(s =>
            s.SourceName.Equals(item.Source, StringComparison.OrdinalIgnoreCase));

        if (scraper is null)
        {
            _logger.LogWarning("Không tìm thấy scraper cho source: '{Source}'", item.Source);
            return null;
        }

        try
        {
            return await scraper.GetMetadataAsync(item, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "[{Source}] Lỗi khi lấy metadata: {Message}",
                item.Source, ex.Message);
            return null;
        }
    }
}
