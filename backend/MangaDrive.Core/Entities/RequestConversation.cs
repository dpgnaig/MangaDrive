namespace MangaDrive.Core.Entities;

public class RequestConversation
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; } // one conversation per member (unique)
    public string Status { get; set; } = "Open"; // "Open" | "Approved" | "Rejected"
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastMessageAt { get; set; } = DateTime.UtcNow;
    public string? LastMessagePreview { get; set; }
    public int MemberUnread { get; set; }
    public int AdminUnread { get; set; }

    public AppUser User { get; set; } = null!;
}
