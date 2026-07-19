namespace MangaDrive.Core.Entities;

public class DmMessage
{
    public Guid Id { get; set; }
    public Guid ConversationId { get; set; }
    public Guid SenderId { get; set; }
    public string Type { get; set; } = "Text"; // "Text" | "Request"
    public string Content { get; set; } = string.Empty;
    public string? Status { get; set; } // null for Text; "Open" | "Approved" | "Rejected" for Request
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DmConversation Conversation { get; set; } = null!;
}
