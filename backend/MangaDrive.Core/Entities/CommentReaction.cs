namespace MangaDrive.Core.Entities;

public class CommentReaction
{
    public Guid Id { get; set; }
    public Guid CommentId { get; set; }
    public Guid UserId { get; set; }
    public string Type { get; set; } = string.Empty; // e.g. "👍", "❤️", "😂", "😮", "😢", "🔥"
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Comment Comment { get; set; } = null!;
    public AppUser User { get; set; } = null!;
}
