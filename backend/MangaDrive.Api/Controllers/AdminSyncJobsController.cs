using MangaDrive.Api.Filters;
using MangaDrive.Core.DTOs;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/admin/sync-jobs")]
[Authorize]
[RequireAdmin]
public class AdminSyncJobsController : ControllerBase
{
    private readonly AppDbContext _db;

    public AdminSyncJobsController(AppDbContext db) => _db = db;

    [HttpGet]
    public async Task<ActionResult<List<SyncJobDto>>> GetAll()
    {
        var jobs = await _db.SyncJobs.Include(j => j.RootFolder)
            .OrderByDescending(j => j.StartedAt)
            .Take(50)
            .Select(j => ToDto(j))
            .ToListAsync();
        return Ok(jobs);
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<SyncJobDto>> Get(Guid id)
    {
        var j = await _db.SyncJobs.Include(j => j.RootFolder).FirstOrDefaultAsync(j => j.Id == id);
        return j == null ? NotFound() : Ok(ToDto(j));
    }

    private static SyncJobDto ToDto(Core.Entities.SyncJob j)
    {
        var total = j.TotalManga + j.TotalChapter + j.TotalImage;
        var synced = j.SyncedManga + j.SyncedChapter + j.SyncedImage;
        var percent = total > 0 ? (int)(synced * 100.0 / total) : 0;
        return new SyncJobDto(j.Id, j.RootFolderId, j.RootFolder.Name, j.Status,
            j.CurrentManga, j.CurrentChapter, j.TotalManga, j.SyncedManga,
            j.TotalChapter, j.SyncedChapter, j.TotalImage, j.SyncedImage, percent, j.Message);
    }
}
