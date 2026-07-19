namespace MangaDrive.Core.Entities;

public class RequestMessage
{
    public Guid Id { get; set; }
    public Guid ConversationId { get; set; }
    public Guid SenderId { get; set; }
    public string SenderRole { get; set; } = "Member"; // "Member" | "Admin"
    public string Content { get; set; } = string.Empty;
    public string? Status { get; set; } // null = normal message; "Open" | "Approved" | "Rejected" when admin labels a member request
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public RequestConversation Conversation { get; set; } = null!;
}
