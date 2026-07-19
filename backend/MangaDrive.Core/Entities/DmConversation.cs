namespace MangaDrive.Core.Entities;

public class DmConversation
{
    public Guid Id { get; set; }
    // Participants stored ordered (smaller GUID string first) so a pair is unique
    public Guid User1Id { get; set; }
    public Guid User2Id { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastMessageAt { get; set; } = DateTime.UtcNow;
    public string? LastMessagePreview { get; set; }
    public int User1Unread { get; set; }
    public int User2Unread { get; set; }
    // Last time each participant read this conversation. A message from the other
    // side is "seen" when the recipient's LastReadAt >= the message's CreatedAt.
    public DateTime? User1LastReadAt { get; set; }
    public DateTime? User2LastReadAt { get; set; }

    public AppUser User1 { get; set; } = null!;
    public AppUser User2 { get; set; } = null!;
}
