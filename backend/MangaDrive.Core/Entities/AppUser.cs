namespace MangaDrive.Core.Entities;

public class AppUser
{
    public Guid Id { get; set; }
    public string GoogleId { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string AvatarUrl { get; set; } = string.Empty;
    public UserRole Role { get; set; } = UserRole.User;
    public bool IsApproved { get; set; }
    public bool IsDisabled { get; set; }
    public bool IsProfileCompleted { get; set; }
    public DateTime? Birthday { get; set; }
    public bool HasChangedName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
