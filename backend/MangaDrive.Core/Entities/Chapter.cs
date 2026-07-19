namespace MangaDrive.Core.Entities;

public class Chapter
{
    public Guid Id { get; set; }
    public Guid MangaId { get; set; }
    public string DriveFileId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? ChapterNumber { get; set; } // e.g. "1", "5.5", "10"
    public string? ChapterName { get; set; } // e.g. "Đây Có Phải Cách Tình Yêu Bắt Đầu?"
    public string? Slug { get; set; } // per-chapter scramble slug from manifest.json ("chapter-<12 hex>")
    public int? Grid { get; set; } // scramble grid size for this chapter, from manifest.json
    public int SortOrder { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Manga Manga { get; set; } = null!;
    public ICollection<ChapterImage> Images { get; set; } = new List<ChapterImage>();
}
