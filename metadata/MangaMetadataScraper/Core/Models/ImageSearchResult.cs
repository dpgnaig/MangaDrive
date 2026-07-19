namespace MangaMetadataScraper.Core.Models;

public class ImageSearchResult
{
    public string Url        { get; set; } = string.Empty;
    public string ThumbUrl   { get; set; } = string.Empty;
    public string Source     { get; set; } = string.Empty; // "MangaDex" | "AniList"
    public string Type       { get; set; } = string.Empty; // "cover" | "banner"
    public string Label      { get; set; } = string.Empty; // mô tả hiển thị
}
