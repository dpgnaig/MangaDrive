namespace MangaDrive.Core.Entities;

public class Comment
{
    public Guid Id { get; set; }
    public Guid MangaId { get; set; }
    public Guid UserId { get; set; }
    public Guid? ParentCommentId { get; set; }
    public string Content { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public Manga Manga { get; set; } = null!;
    public AppUser User { get; set; } = null!;
    public Comment? ParentComment { get; set; }
    public ICollection<Comment> Replies { get; set; } = new List<Comment>();
    public ICollection<CommentReaction> Reactions { get; set; } = new List<CommentReaction>();
}
