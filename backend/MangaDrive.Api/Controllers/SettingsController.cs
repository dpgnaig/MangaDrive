using System.Security.Cryptography;
using System.Text;
using MangaDrive.Api.Filters;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

public record UpdateAnnouncementRequest(string Value);
public record VerifyMasterPasswordRequest(string Password);

[ApiController]
[Route("api/settings")]
public class SettingsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IConfiguration _config;

    public SettingsController(AppDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

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

    // Admin: verify a typed master key against the real Scramble:MasterKey env value.
    // There's nothing to "set" — the key lives only in server config, never in the DB
    // or the client bundle, so this is the sole source of truth for the check.
    [HttpPost("master-password/verify")]
    [Authorize]
    [RequireAdmin]
    public IActionResult VerifyMasterPassword([FromBody] VerifyMasterPasswordRequest req)
    {
        var actualKey = _config["Scramble:MasterKey"] ?? "";
        var typedKey = req.Password ?? "";

        var actualBytes = Encoding.UTF8.GetBytes(actualKey);
        var typedBytes = Encoding.UTF8.GetBytes(typedKey);

        // Fixed-time compare needs equal-length buffers; pad the shorter one so the
        // comparison itself never leaks length via timing, then also check length.
        var maxLen = Math.Max(actualBytes.Length, typedBytes.Length);
        var actualPadded = new byte[maxLen];
        var typedPadded = new byte[maxLen];
        Array.Copy(actualBytes, actualPadded, actualBytes.Length);
        Array.Copy(typedBytes, typedPadded, typedBytes.Length);

        var valid = actualBytes.Length == typedBytes.Length
            && CryptographicOperations.FixedTimeEquals(actualPadded, typedPadded)
            && actualKey.Length > 0;

        return Ok(new { valid });
    }
}
