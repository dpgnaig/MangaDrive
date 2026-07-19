using System.Security.Claims;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/users")]
[Authorize]
public class UsersController : ControllerBase
{
    private readonly AppDbContext _db;

    public UsersController(AppDbContext db) => _db = db;

    private Guid UserId => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    /// <summary>
    /// Search users by display name or email (for starting a DM).
    /// Excludes self and disabled accounts. Capped at 20 results.
    /// </summary>
    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string? q = null)
    {
        var me = UserId;
        var query = _db.Users.Where(u => u.Id != me && !u.IsDisabled);

        if (!string.IsNullOrWhiteSpace(q))
        {
            var s = q.Trim().ToLower();
            query = query.Where(u => u.DisplayName.ToLower().Contains(s) || u.Email.ToLower().Contains(s));
        }

        var users = await query
            .OrderBy(u => u.DisplayName)
            .Take(20)
            .Select(u => new { u.Id, u.DisplayName, u.AvatarUrl, u.Role })
            .ToListAsync();

        return Ok(users);
    }
}
