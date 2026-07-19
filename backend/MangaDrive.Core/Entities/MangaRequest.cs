namespace MangaDrive.Core.Entities;

public class MangaRequest
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? ReferenceUrl { get; set; }
    public string Status { get; set; } = "Pending"; // "Pending" | "Approved" | "Rejected"
    public string? AdminNote { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? RespondedAt { get; set; }

    public AppUser User { get; set; } = null!;
}
