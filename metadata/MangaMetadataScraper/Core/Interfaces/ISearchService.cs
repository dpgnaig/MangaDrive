using MangaMetadataScraper.Core.Models;

namespace MangaMetadataScraper.Core.Interfaces;

public interface ISearchService
{
    /// <summary>
    /// Search song song tất cả scrapers, gộp toàn bộ kết quả lại.
    /// Giữ nguyên thứ tự: kết quả của từng site theo nhóm.
    /// </summary>
    Task<List<SearchResultItem>> SearchAllAsync(
        string keyword,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Lấy metadata đầy đủ từ item đã chọn, route về đúng scraper theo Source.
    /// </summary>
    Task<MangaMetadata?> GetMetadataAsync(
        SearchResultItem item,
        CancellationToken cancellationToken = default);
}
