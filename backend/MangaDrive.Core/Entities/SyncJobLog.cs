namespace MangaDrive.Core.Entities;

public class SyncJobLog
{
    public Guid Id { get; set; }
    public Guid SyncJobId { get; set; }
    public string Level { get; set; } = "Info"; // Info, Warning, Error
    public string Message { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public SyncJob SyncJob { get; set; } = null!;
}
