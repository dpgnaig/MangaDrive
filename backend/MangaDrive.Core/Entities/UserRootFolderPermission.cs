namespace MangaDrive.Core.Entities;

public class UserRootFolderPermission
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid RootFolderId { get; set; }
    public AppUser User { get; set; } = null!;
    public MangaRootFolder RootFolder { get; set; } = null!;
}
