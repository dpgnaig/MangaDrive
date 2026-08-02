using MangaDrive.Api.Filters;
using MangaDrive.Core.DTOs;
using MangaDrive.Core.Entities;
using MangaDrive.Core.Interfaces;
using MangaDrive.Infrastructure.Data;
using MangaDrive.Infrastructure.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/admin/root-folders")]
[Authorize]
[RequireAdmin]
public class AdminRootFoldersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IGoogleDriveService _drive;
    private readonly ILogger<AdminRootFoldersController> _logger;

    public AdminRootFoldersController(AppDbContext db, IGoogleDriveService drive, ILogger<AdminRootFoldersController> logger)
    {
        _db = db;
        _drive = drive;
        _logger = logger;
    }

    [HttpGet]
    public async Task<ActionResult<List<RootFolderDto>>> GetAll()
    {
        var items = await _db.RootFolders.Select(r =>
            new RootFolderDto(r.Id, r.Name, r.GoogleDriveFolderId, r.IsPublic, r.IsActive, r.IsAutoAdded)).ToListAsync();
        return Ok(items);
    }

    [HttpPost]
    public async Task<ActionResult<RootFolderDto>> Create([FromBody] CreateRootFolderRequest req)
    {
        var folder = new MangaRootFolder
        {
            Name = req.Name,
            GoogleDriveFolderId = req.GoogleDriveFolderId,
            IsPublic = req.IsPublic
        };
        _db.RootFolders.Add(folder);
        await _db.SaveChangesAsync();
        return Ok(new RootFolderDto(folder.Id, folder.Name, folder.GoogleDriveFolderId, folder.IsPublic, folder.IsActive, folder.IsAutoAdded));
    }

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateRootFolderRequest req)
    {
        var folder = await _db.RootFolders.FindAsync(id);
        if (folder == null) return NotFound();
        folder.Name = req.Name;
        folder.IsPublic = req.IsPublic;
        folder.IsActive = req.IsActive;
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id)
    {
        var folder = await _db.RootFolders.FindAsync(id);
        if (folder == null) return NotFound();
        if (folder.IsAutoAdded) return BadRequest("Không thể xóa folder được tự động thêm từ Drive Shared");

        // Handle linked mangas: for each manga in this root that is a primary,
        // promote a linked manga from another root to become new primary
        var mangasInRoot = await _db.Mangas.Where(m => m.RootFolderId == id).ToListAsync();
        foreach (var manga in mangasInRoot)
        {
            var linkedMangas = await _db.Mangas.Where(m => m.LinkedMangaId == manga.Id).ToListAsync();
            if (linkedMangas.Count > 0)
            {
                // Promote first linked manga to primary
                var newPrimary = linkedMangas[0];
                newPrimary.LinkedMangaId = null;

                // Point remaining to new primary
                for (int i = 1; i < linkedMangas.Count; i++)
                {
                    linkedMangas[i].LinkedMangaId = newPrimary.Id;
                }
            }
        }
        await _db.SaveChangesAsync();

        // Explicitly remove dependent data before removing the mangas themselves —
        // matches AdminMangasController.Delete. Don't rely solely on DB-level cascade
        // (which requires SQLite FK enforcement to be on) or EF's in-memory cascade
        // (which only reaches entities actually loaded into the change tracker).
        var mangaIds = mangasInRoot.Select(m => m.Id).ToList();
        var chapters = await _db.Chapters.Where(c => mangaIds.Contains(c.MangaId)).ToListAsync();
        var chapterIds = chapters.Select(c => c.Id).ToList();
        _db.ChapterImages.RemoveRange(_db.ChapterImages.Where(ci => chapterIds.Contains(ci.ChapterId)));
        _db.Chapters.RemoveRange(chapters);
        _db.Comments.RemoveRange(_db.Comments.Where(c => mangaIds.Contains(c.MangaId)));
        _db.Favorites.RemoveRange(_db.Favorites.Where(f => mangaIds.Contains(f.MangaId)));
        _db.ReadingHistories.RemoveRange(_db.ReadingHistories.Where(r => mangaIds.Contains(r.MangaId)));
        _db.UserMangaPermissions.RemoveRange(_db.UserMangaPermissions.Where(p => mangaIds.Contains(p.MangaId)));
        _db.Mangas.RemoveRange(mangasInRoot);

        _db.RootFolders.Remove(folder);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpGet("{id:guid}/scan")]
    public async Task<IActionResult> Scan(Guid id)
    {
        var folder = await _db.RootFolders.FindAsync(id);
        if (folder == null) return NotFound();

        // List child folders from Google Drive (just folder names, no deep scan)
        var driveFolders = await _drive.ListFoldersAsync(folder.GoogleDriveFolderId);

        // Get existing mangas for this root folder
        var existingMangas = await _db.Mangas
            .Where(m => m.RootFolderId == id)
            .Select(m => new { m.Id, m.DriveFileId, m.Title, m.UpdatedAt })
            .ToListAsync();

        var existingByDriveId = existingMangas.ToDictionary(m => m.DriveFileId);

        var driveFolderIds = driveFolders.Select(df => df.Id).ToHashSet();

        var result = driveFolders.Select(df => {
            var exists = existingByDriveId.TryGetValue(df.Id, out var manga);
            return new
            {
                driveFileId = df.Id,
                name = df.Name,
                synced = exists,
                mangaId = exists ? manga!.Id : (Guid?)null,
                mangaTitle = exists ? manga!.Title : null,
                lastSynced = exists ? manga!.UpdatedAt : (DateTime?)null
            };
        }).OrderBy(x => x.name).ToList();

        // Detect orphans: mangas in DB but no longer on Drive
        var orphans = existingMangas
            .Where(m => !driveFolderIds.Contains(m.DriveFileId))
            .Select(m => new { m.Id, m.Title, m.DriveFileId })
            .OrderBy(m => m.Title)
            .ToList();

        return Ok(new
        {
            total = result.Count,
            synced = result.Count(x => x.synced),
            notSynced = result.Count(x => !x.synced),
            orphanCount = orphans.Count,
            folders = result,
            orphans
        });
    }

    [HttpGet("{id:guid}/detect-new-chapters")]
    public async Task<IActionResult> DetectNewChapters(Guid id)
    {
        var folder = await _db.RootFolders.FindAsync(id);
        if (folder == null) return NotFound();

        var mangas = await _db.Mangas
            .Where(m => m.RootFolderId == id)
            .Select(m => new { m.Id, m.DriveFileId, m.Title })
            .ToListAsync();

        var results = new List<object>();
        var totalNew = 0;

        foreach (var manga in mangas)
        {
            try
            {
                var driveFolders = await _drive.ListFoldersAsync(manga.DriveFileId);
                var existingDriveIds = await _db.Chapters
                    .Where(c => c.MangaId == manga.Id)
                    .Select(c => c.DriveFileId)
                    .ToListAsync();
                var existingSet = existingDriveIds.ToHashSet();
                var unmatched = driveFolders.Where(f => !existingSet.Contains(f.Id)).ToList();
                if (unmatched.Count == 0) continue;

                // A folder named like a scramble slug (chapter-xxxxxxxxxxxx) with no
                // matching Chapter row is usually not a "new" chapter waiting to be
                // synced — MangaSyncService intentionally skips slug folders that have
                // no manifest.json entry yet (checkpoint upload still in progress, or
                // an aborted upload left an orphan folder behind). Without this same
                // check here, such an orphan gets flagged as "new" forever, since sync
                // will keep skipping it every single run. Only fetch manifest.json when
                // there's actually an unmatched slug-shaped folder to disambiguate.
                HashSet<string>? manifestSlugs = null;
                var newChapters = new List<string>();
                foreach (var f in unmatched)
                {
                    if (ScrambleManifestUtil.SlugPattern.IsMatch(f.Name))
                    {
                        manifestSlugs ??= await ScrambleManifestUtil.ReadManifestSlugsAsync(
                            _drive, await _drive.ListFilesAsync(manga.DriveFileId));
                        if (!manifestSlugs.Contains(f.Name)) continue; // orphan, not new
                    }
                    newChapters.Add(f.Name);
                }

                if (newChapters.Count > 0)
                {
                    results.Add(new { manga.Id, manga.Title, newCount = newChapters.Count, chapters = newChapters });
                    totalNew += newChapters.Count;
                }
            }
            catch { /* Skip if Drive access fails for this manga */ }
        }

        return Ok(new { totalNew, mangas = results });
    }

    [HttpPost("{id:guid}/sync-new")]
    public async Task<IActionResult> SyncNewOnly(Guid id)
    {
        var folder = await _db.RootFolders.FindAsync(id);
        if (folder == null) return NotFound();

        // List Drive folders and find ones not yet in DB
        var driveFolders = await _drive.ListFoldersAsync(folder.GoogleDriveFolderId);
        var existingDriveIds = await _db.Mangas
            .Where(m => m.RootFolderId == id)
            .Select(m => m.DriveFileId)
            .ToListAsync();
        var existingSet = existingDriveIds.ToHashSet();

        var newFolders = driveFolders.Where(df => !existingSet.Contains(df.Id)).ToList();
        if (newFolders.Count == 0) return Ok(new { message = "Không có manga mới", count = 0 });

        // Create manga entries for new folders then queue sync for each
        foreach (var df in newFolders)
        {
            var manga = new Manga { RootFolderId = id, DriveFileId = df.Id, Title = df.Name };
            _db.Mangas.Add(manga);
            await _db.SaveChangesAsync();
            await SyncBackgroundService.Queue.Writer.WriteAsync(new SyncRequest(manga.Id, SyncRequestType.Manga));
        }

        return Accepted(new { message = $"Đang sync {newFolders.Count} manga mới", count = newFolders.Count });
    }

    [HttpPost("{rootId:guid}/sync-folder")]
    public async Task<IActionResult> SyncSingleByDriveId(Guid rootId, [FromBody] SyncFolderRequest req)
    {
        var folder = await _db.RootFolders.FindAsync(rootId);
        if (folder == null) return NotFound();

        // Find or create manga by driveFileId
        var manga = await _db.Mangas.FirstOrDefaultAsync(m => m.RootFolderId == rootId && m.DriveFileId == req.DriveFileId);
        if (manga == null)
        {
            manga = new Manga { RootFolderId = rootId, DriveFileId = req.DriveFileId, Title = req.Name ?? "Unknown" };
            _db.Mangas.Add(manga);
            await _db.SaveChangesAsync();
        }

        await SyncBackgroundService.Queue.Writer.WriteAsync(new SyncRequest(manga.Id, SyncRequestType.Manga));
        return Accepted(new { mangaId = manga.Id });
    }

    [HttpPost("{id:guid}/sync")]
    public async Task<IActionResult> Sync(Guid id)
    {
        var folder = await _db.RootFolders.FindAsync(id);
        if (folder == null) return NotFound();
        await SyncBackgroundService.Queue.Writer.WriteAsync(new SyncRequest(id, SyncRequestType.RootFolder));
        return Accepted();
    }

    /// <summary>
    /// On-demand version of AutoSyncService's 30-minute shared-folder scan. Lets a
    /// caller (e.g. the scramble tool, right after it shares a freshly-uploaded manga
    /// folder with the service account) surface a newly-shared root immediately instead
    /// of waiting for the next timer tick.
    ///
    /// Retries with backoff: Drive's `sharedWithMe` search index is eventually
    /// consistent, so a permission that just committed via Permissions.create can take
    /// several seconds to tens of seconds before it shows up in ListSharedFoldersAsync's
    /// query. A single immediate scan reliably races that index and comes back empty —
    /// this loop rides out that window instead of relying solely on the 30-minute timer.
    /// </summary>
    [HttpPost("detect-new-shared")]
    public async Task<IActionResult> DetectNewShared()
    {
        var delaysMs = new[] { 0, 3000, 5000, 8000, 15000 };
        int queued = 0;
        foreach (var delay in delaysMs)
        {
            if (delay > 0) await Task.Delay(delay, HttpContext.RequestAborted);
            queued = await AutoSyncService.DetectNewSharedFolders(_db, _drive, _logger, HttpContext.RequestAborted);
            if (queued > 0) break;
        }
        return Ok(new { queued });
    }
}
