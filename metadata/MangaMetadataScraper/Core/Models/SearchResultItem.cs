namespace MangaMetadataScraper.Core.Models;

/// <summary>
/// Kết quả gọn từ search — dùng để hiển thị danh sách cho user chọn.
/// Chưa có metadata đầy đủ.
/// </summary>
public class SearchResultItem
{
    public string Title      { get; set; } = string.Empty;
    public string CoverUrl   { get; set; } = string.Empty;
    public string Source     { get; set; } = string.Empty;
    public string DetailUrl  { get; set; } = string.Empty;
    public string Slug       { get; set; } = string.Empty;

    /// <summary>Dữ liệu thô từ search để scraper dùng khi fetch detail.</summary>
    public string RawId      { get; set; } = string.Empty;
}
