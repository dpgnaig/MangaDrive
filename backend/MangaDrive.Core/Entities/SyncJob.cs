namespace MangaDrive.Core.Entities;

public class SyncJob
{
    public Guid Id { get; set; }
    public Guid RootFolderId { get; set; }
    public string Status { get; set; } = "Pending"; // Pending, Running, Completed, Failed
    public int TotalManga { get; set; }
    public int SyncedManga { get; set; }
    public int TotalChapter { get; set; }
    public int SyncedChapter { get; set; }
    public int TotalImage { get; set; }
    public int SyncedImage { get; set; }
    public string? CurrentManga { get; set; }
    public string? CurrentChapter { get; set; }
    public string? Message { get; set; }
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
    public MangaRootFolder RootFolder { get; set; } = null!;
    public ICollection<SyncJobLog> Logs { get; set; } = new List<SyncJobLog>();
}
