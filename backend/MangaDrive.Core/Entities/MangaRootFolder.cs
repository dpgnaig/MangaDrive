namespace MangaDrive.Core.Entities;

public class MangaRootFolder
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string GoogleDriveFolderId { get; set; } = string.Empty;
    public bool IsPublic { get; set; }
    public bool IsActive { get; set; } = true;
    public bool IsAutoAdded { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Google Drive Changes API page token for this root folder's scope.
    /// Used to efficiently detect changes since last sync.
    /// </summary>
    public string? ChangesPageToken { get; set; }

    /// <summary>
    /// Timestamp of the last successful sync for this root folder.
    /// </summary>
    public DateTime? LastSyncedAt { get; set; }

    public ICollection<Manga> Mangas { get; set; } = new List<Manga>();
}
