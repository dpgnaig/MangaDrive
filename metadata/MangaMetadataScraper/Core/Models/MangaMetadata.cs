namespace MangaMetadataScraper.Core.Models;

public class TitleEntry
{
    public string Lang  { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
}

public class MangaMetadata
{
    public string Title            { get; set; } = string.Empty;
    public string AlternativeTitle { get; set; } = string.Empty;
    public List<TitleEntry> OtherTitles { get; set; } = [];
    public string Description      { get; set; } = string.Empty;
    public string Author           { get; set; } = string.Empty;
    public string Artist           { get; set; } = string.Empty;
    public List<string> Genres     { get; set; } = [];
    public List<string> Themes     { get; set; } = [];
    public string Demographic      { get; set; } = string.Empty;
    public string Status           { get; set; } = string.Empty;

    // ── Cover / Banner từ site gốc ────────────────────────────────────────────
    public string CoverUrl         { get; set; } = string.Empty;
    public List<string> CoverUrls  { get; set; } = [];

    /// <summary>Bytes ảnh bìa tải qua browser (vượt hotlink/anti-leech).</summary>
    public byte[]? CoverImageBytes { get; set; }

    // ── Titles dùng để search ảnh (MangaDex / AniList) ──────────────────────
    /// <summary>
    /// Danh sách tên để query image search, đã sắp xếp theo độ ưu tiên:
    /// tiếng Anh → tiếng Nhật → tên gốc site.
    /// </summary>
    public List<string> SearchTitles { get; set; } = [];

    // ── Ảnh từ nguồn ngoài (MangaDex, AniList) ────────────────────────────
    /// <summary>URL cover được chọn từ MangaDex / AniList.</summary>
    public string ExternalCoverUrl  { get; set; } = string.Empty;

    /// <summary>URL banner được chọn từ AniList.</summary>
    public string ExternalBannerUrl { get; set; } = string.Empty;

    public string Source    { get; set; } = string.Empty;
    public string DetailUrl { get; set; } = string.Empty;
}
