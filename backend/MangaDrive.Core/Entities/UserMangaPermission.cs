namespace MangaDrive.Core.Entities;

public class UserMangaPermission
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid MangaId { get; set; }
    public AppUser User { get; set; } = null!;
    public Manga Manga { get; set; } = null!;
}
