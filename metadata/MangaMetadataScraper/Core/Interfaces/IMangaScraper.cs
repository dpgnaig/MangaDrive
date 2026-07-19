using MangaMetadataScraper.Core.Models;

namespace MangaMetadataScraper.Core.Interfaces;

public interface IMangaScraper
{
    string SourceName { get; }

    /// <summary>
    /// Tìm kiếm và trả về TOÀN BỘ kết quả tìm được từ site.
    /// Không lọc, không bỏ sót.
    /// </summary>
    Task<List<SearchResultItem>> SearchAsync(
        string keyword,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Lấy metadata đầy đủ từ 1 item đã được user chọn.
    /// </summary>
    Task<MangaMetadata?> GetMetadataAsync(
        SearchResultItem item,
        CancellationToken cancellationToken = default);
}
