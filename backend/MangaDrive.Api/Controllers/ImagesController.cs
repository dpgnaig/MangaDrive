using MangaDrive.Api.Filters;
using MangaDrive.Core.Interfaces;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/images")]
[Authorize]
[RequireApproved]
public class ImagesController : ControllerBase
{
    private readonly IGoogleDriveService _drive;
    private readonly AppDbContext _db;

    public ImagesController(IGoogleDriveService drive, AppDbContext db)
    {
        _drive = drive;
        _db = db;
    }

    [HttpGet("{fileId}")]
    public async Task<IActionResult> Get(string fileId)
    {
        // Only proxy Drive files that are actually part of a manga (chapter page,
        // cover, or banner). Without this any approved user could stream ANY file
        // the service account can see by guessing/enumerating Drive ids (IDOR).
        var known = await _db.ChapterImages.AnyAsync(ci => ci.DriveFileId == fileId)
            || await _db.Mangas.AnyAsync(m => m.CoverImageFileId == fileId || m.BannerImageFileId == fileId);
        if (!known) return NotFound();

        try
        {
            var stream = await _drive.DownloadFileAsync(fileId);
            return File(stream, "image/jpeg");
        }
        catch
        {
            return NotFound();
        }
    }
}
