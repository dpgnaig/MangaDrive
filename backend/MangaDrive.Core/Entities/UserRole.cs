namespace MangaDrive.Core.Entities;

/// <summary>
/// Account role. Persisted as its string name ("User" | "Admin") via an EF value
/// converter, so the JWT role claim and [Authorize(Roles = "Admin")] keep matching
/// on the same literals.
/// </summary>
public enum UserRole
{
    User = 0,
    Admin = 1
}
