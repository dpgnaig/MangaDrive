namespace MangaDrive.Core.Entities;

public class ReadingHistory
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid MangaId { get; set; }
    public Guid ChapterId { get; set; }
    public int PageIndex { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public AppUser User { get; set; } = null!;
    public Manga Manga { get; set; } = null!;
    public Chapter Chapter { get; set; } = null!;
}
