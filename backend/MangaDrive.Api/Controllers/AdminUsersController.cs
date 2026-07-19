using System.Security.Claims;
using MangaDrive.Api.Filters;
using MangaDrive.Core.DTOs;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/admin/users")]
[Authorize]
[RequireAdmin]
public class AdminUsersController : ControllerBase
{
    private readonly AppDbContext _db;

    public AdminUsersController(AppDbContext db) => _db = db;

    [HttpGet]
    public async Task<IActionResult> GetAll(
        [FromQuery] string? search = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        var (p, size) = new PaginationQuery(page, pageSize).Normalized();

        var query = _db.Users.AsQueryable();

        if (!string.IsNullOrWhiteSpace(search))
        {
            var s = search.Trim();
            query = query.Where(u => u.DisplayName.Contains(s) || u.Email.Contains(s));
        }

        query = query.OrderBy(u => u.DisplayName);

        var total = await query.CountAsync();
        var items = await query
            .Skip((p - 1) * size)
            .Take(size)
            .Select(u => new UserDto(u.Id, u.Email, u.DisplayName, u.AvatarUrl, u.Role, u.IsApproved, u.IsDisabled, u.IsProfileCompleted, u.HasChangedName))
            .ToListAsync();

        return Ok(PaginatedResult<UserDto>.Create(items, total, p, size));
    }

    [HttpPost("{userId:guid}/disable")]
    public async Task<IActionResult> Disable(Guid userId)
    {
        var user = await _db.Users.FindAsync(userId);
        if (user == null) return NotFound();

        // Only guard the disable direction (re-enabling is always fine).
        if (!user.IsDisabled)
        {
            var me = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
            // Can't disable yourself — otherwise an admin can lock themselves out.
            if (user.Id == me)
                return BadRequest(new { message = "Không thể vô hiệu hóa chính bạn" });
            // Can't disable the last active admin, or the site loses all admins.
            if (user.Role == UserRole.Admin)
            {
                var otherActiveAdmins = await _db.Users
                    .CountAsync(u => u.Role == UserRole.Admin && !u.IsDisabled && u.Id != user.Id);
                if (otherActiveAdmins == 0)
                    return BadRequest(new { message = "Không thể vô hiệu hóa admin cuối cùng" });
            }
        }

        user.IsDisabled = !user.IsDisabled;

        // Notify user about status change
        _db.Notifications.Add(new Notification
        {
            UserId = userId,
            Type = user.IsDisabled ? "user_disabled" : "user_enabled",
            Title = user.IsDisabled ? "Tài khoản bị vô hiệu hóa" : "Tài khoản đã được kích hoạt lại",
            Message = user.IsDisabled
                ? "Tài khoản của bạn đã bị admin vô hiệu hóa. Liên hệ admin để biết thêm chi tiết."
                : "Tài khoản của bạn đã được kích hoạt trở lại. Bạn có thể truy cập bình thường.",
            Link = "/"
        });

        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpDelete("{userId:guid}")]
    public async Task<IActionResult> Delete(Guid userId)
    {
        var user = await _db.Users.FindAsync(userId);
        if (user == null) return NotFound();
        _db.Users.Remove(user);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPost("{userId:guid}/root-permissions")]
    public async Task<IActionResult> AddRootPermission(Guid userId, [FromBody] PermissionRequest req)
    {
        var exists = await _db.UserRootFolderPermissions
            .AnyAsync(p => p.UserId == userId && p.RootFolderId == req.TargetId);
        if (!exists)
        {
            _db.UserRootFolderPermissions.Add(new UserRootFolderPermission
            {
                UserId = userId,
                RootFolderId = req.TargetId
            });
            await _db.SaveChangesAsync();
        }
        return NoContent();
    }

    [HttpPost("{userId:guid}/manga-permissions")]
    public async Task<IActionResult> AddMangaPermission(Guid userId, [FromBody] PermissionRequest req)
    {
        var exists = await _db.UserMangaPermissions
            .AnyAsync(p => p.UserId == userId && p.MangaId == req.TargetId);
        if (!exists)
        {
            _db.UserMangaPermissions.Add(new UserMangaPermission
            {
                UserId = userId,
                MangaId = req.TargetId
            });
            await _db.SaveChangesAsync();
        }
        return NoContent();
    }
}
