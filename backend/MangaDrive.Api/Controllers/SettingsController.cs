using MangaDrive.Api.Filters;
using MangaDrive.Api.Security;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

public record UpdateAnnouncementRequest(string Value);
public record SetMasterPasswordRequest(string? CurrentPassword, string NewPassword);
public record VerifyMasterPasswordRequest(string Password);

[ApiController]
[Route("api/settings")]
public class SettingsController : ControllerBase
{
    private readonly AppDbContext _db;

    public SettingsController(AppDbContext db) => _db = db;

    // Public: anyone can read the announcement banner text
    [HttpGet("announcement")]
    public async Task<ActionResult<string>> GetAnnouncement()
    {
        var setting = await _db.Settings.FirstOrDefaultAsync(s => s.Key == "announcement");
        return Ok(setting?.Value ?? "");
    }

    // Admin: update the announcement banner text
    [HttpPut("announcement")]
    [Authorize]
    [RequireAdmin]
    public async Task<IActionResult> UpdateAnnouncement([FromBody] UpdateAnnouncementRequest req)
    {
        var setting = await _db.Settings.FirstOrDefaultAsync(s => s.Key == "announcement");
        if (setting == null)
        {
            setting = new Setting { Key = "announcement", Value = req.Value ?? "" };
            _db.Settings.Add(setting);
        }
        else
        {
            setting.Value = req.Value ?? "";
        }
        await _db.SaveChangesAsync();
        return NoContent();
    }

    // Admin: whether a master password has been set yet
    [HttpGet("master-password/status")]
    [Authorize]
    [RequireAdmin]
    public async Task<IActionResult> MasterPasswordStatus()
    {
        var exists = await _db.Settings.AnyAsync(s => s.Key == "master_password_hash");
        return Ok(new { isSet = exists });
    }

    // Admin: set or change the master password. If already set, CurrentPassword must verify.
    [HttpPost("master-password")]
    [Authorize]
    [RequireAdmin]
    public async Task<IActionResult> SetMasterPassword([FromBody] SetMasterPasswordRequest req)
    {
        if (string.IsNullOrEmpty(req.NewPassword))
            return BadRequest(new { message = "Mật khẩu mới không được để trống" });

        var setting = await _db.Settings.FirstOrDefaultAsync(s => s.Key == "master_password_hash");
        if (setting != null)
        {
            if (string.IsNullOrEmpty(req.CurrentPassword) || !PasswordHasher.Verify(req.CurrentPassword, setting.Value))
                return BadRequest(new { message = "Master password hiện tại không đúng" });
            setting.Value = PasswordHasher.Hash(req.NewPassword);
        }
        else
        {
            setting = new Setting { Key = "master_password_hash", Value = PasswordHasher.Hash(req.NewPassword) };
            _db.Settings.Add(setting);
        }
        await _db.SaveChangesAsync();
        return NoContent();
    }

    // Admin: verify a master password against the stored hash
    [HttpPost("master-password/verify")]
    [Authorize]
    [RequireAdmin]
    public async Task<IActionResult> VerifyMasterPassword([FromBody] VerifyMasterPasswordRequest req)
    {
        var setting = await _db.Settings.FirstOrDefaultAsync(s => s.Key == "master_password_hash");
        var valid = setting != null && PasswordHasher.Verify(req.Password ?? "", setting.Value);
        return Ok(new { valid });
    }
}
