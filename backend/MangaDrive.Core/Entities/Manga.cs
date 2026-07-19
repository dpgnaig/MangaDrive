namespace MangaDrive.Core.Entities;

public class Manga
{
    public Guid Id { get; set; }
    public Guid RootFolderId { get; set; }
    public string DriveFileId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string OtherTitles { get; set; } = string.Empty; // JSON array stored as string
    public string Description { get; set; } = string.Empty;
    public string Author { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty; // ongoing, completed
    public string Genres { get; set; } = string.Empty; // JSON array stored as string
    public string CoverImageFileId { get; set; } = string.Empty;
    public string BannerImageFileId { get; set; } = string.Empty;
    public bool IsHidden { get; set; }
    public Guid? LinkedMangaId { get; set; }
    public int ViewCount { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public MangaRootFolder RootFolder { get; set; } = null!;
    public ICollection<Chapter> Chapters { get; set; } = new List<Chapter>();
    public ICollection<Comment> Comments { get; set; } = new List<Comment>();
}
