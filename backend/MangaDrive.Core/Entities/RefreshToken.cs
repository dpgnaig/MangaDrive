namespace MangaDrive.Core.Entities;

/// <summary>
/// A refresh token, stored hashed (never the raw value). Rotation: each successful
/// refresh revokes the current row and links the replacement via ReplacedByTokenHash,
/// so a reused (already-rotated) token can be detected and the whole chain revoked.
/// </summary>
public class RefreshToken
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    // SHA-256 hash of the raw token; the raw value only ever lives in the client cookie.
    public string TokenHash { get; set; } = string.Empty;
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? RevokedAt { get; set; }
    // Hash of the token that replaced this one on rotation (null until rotated).
    public string? ReplacedByTokenHash { get; set; }

    public bool IsActive => RevokedAt == null && DateTime.UtcNow < ExpiresAt;

    public AppUser User { get; set; } = null!;
}
