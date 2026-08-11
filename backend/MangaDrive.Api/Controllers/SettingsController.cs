using MangaDrive.Api.Filters;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

public record UpdateAnnouncementRequest(string Value);

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
}
