using System.Security.Claims;
using MangaDrive.Api.Filters;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api")]
[Authorize]
[RequireApproved]
public class UserDataController : ControllerBase
{
    private readonly AppDbContext _db;
    private Guid UserId => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    public UserDataController(AppDbContext db) => _db = db;

    // === Favorites ===
    [HttpGet("favorites")]
    public async Task<IActionResult> GetFavorites()
    {
        var favs = await _db.Favorites.Where(f => f.UserId == UserId)
            .Include(f => f.Manga).OrderByDescending(f => f.CreatedAt)
            .Select(f => new { f.Manga.Id, f.Manga.Title, f.Manga.CoverImageFileId, ChapterCount = f.Manga.Chapters.Count })
            .ToListAsync();
        return Ok(favs);
    }

    [HttpPost("favorites/{mangaId:guid}")]
    public async Task<IActionResult> ToggleFavorite(Guid mangaId)
    {
        var existing = await _db.Favorites.FirstOrDefaultAsync(f => f.UserId == UserId && f.MangaId == mangaId);
        if (existing != null)
        {
            _db.Favorites.Remove(existing);
            await _db.SaveChangesAsync();
            return Ok(new { isFavorite = false });
        }
        _db.Favorites.Add(new Favorite { UserId = UserId, MangaId = mangaId });
        await _db.SaveChangesAsync();
        return Ok(new { isFavorite = true });
    }

    [HttpGet("favorites/check/{mangaId:guid}")]
    public async Task<IActionResult> CheckFavorite(Guid mangaId)
    {
        var isFav = await _db.Favorites.AnyAsync(f => f.UserId == UserId && f.MangaId == mangaId);
        return Ok(new { isFavorite = isFav });
    }

    // === Reading History / Continue Reading ===
    [HttpPost("reading-progress")]
    public async Task<IActionResult> SaveProgress([FromBody] SaveProgressRequest req)
    {
        var history = await _db.ReadingHistories.FirstOrDefaultAsync(r => r.UserId == UserId && r.MangaId == req.MangaId);
        if (history == null)
        {
            try
            {
                _db.ReadingHistories.Add(new ReadingHistory { UserId = UserId, MangaId = req.MangaId, ChapterId = req.ChapterId, PageIndex = req.PageIndex });
                // Increment ViewCount on first read by this user
                await _db.Mangas.Where(m => m.Id == req.MangaId).ExecuteUpdateAsync(s => s.SetProperty(m => m.ViewCount, m => m.ViewCount + 1));
                await _db.SaveChangesAsync();
            }
            catch (DbUpdateException)
            {
                // Race condition - record was just created, update instead
                _db.ChangeTracker.Clear();
                history = await _db.ReadingHistories.FirstOrDefaultAsync(r => r.UserId == UserId && r.MangaId == req.MangaId);
                if (history != null) { history.ChapterId = req.ChapterId; history.PageIndex = req.PageIndex; history.UpdatedAt = DateTime.UtcNow; await _db.SaveChangesAsync(); }
            }
        }
        else
        {
            history.ChapterId = req.ChapterId;
            history.PageIndex = req.PageIndex;
            history.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
        }
        return Ok();
    }

    [HttpGet("reading-history")]
    public async Task<IActionResult> GetHistory()
    {
        var history = await _db.ReadingHistories.Where(r => r.UserId == UserId)
            .Include(r => r.Manga).Include(r => r.Chapter)
            .OrderByDescending(r => r.UpdatedAt).Take(20)
            .Select(r => new { r.Manga.Id, r.Manga.Title, r.Manga.CoverImageFileId, ChapterId = r.ChapterId, ChapterName = r.Chapter.Name, r.PageIndex, r.UpdatedAt })
            .ToListAsync();
        return Ok(history);
    }

    [HttpGet("continue-reading")]
    public async Task<IActionResult> GetContinueReading()
    {
        var isAdmin = User.IsInRole("Admin");
        var query = _db.ReadingHistories.Where(r => r.UserId == UserId)
            .Include(r => r.Manga).Include(r => r.Chapter);

        var items = await query
            .Where(r => isAdmin || !r.Manga.IsHidden)
            .OrderByDescending(r => r.UpdatedAt).Take(5)
            .Select(r => new { r.Id, MangaId = r.Manga.Id, r.Manga.Title, r.Manga.CoverImageFileId, r.ChapterId, ChapterName = r.Chapter.Name, r.PageIndex })
            .ToListAsync();
        return Ok(items);
    }

    [HttpDelete("continue-reading/{id:guid}")]
    public async Task<IActionResult> RemoveContinueReading(Guid id)
    {
        var item = await _db.ReadingHistories.FirstOrDefaultAsync(r => r.Id == id && r.UserId == UserId);
        if (item == null) return NotFound();
        _db.ReadingHistories.Remove(item);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPost("reading-history/clear")]
    public async Task<IActionResult> ClearHistory()
    {
        var items = await _db.ReadingHistories.Where(r => r.UserId == UserId).ToListAsync();
        _db.ReadingHistories.RemoveRange(items);
        await _db.SaveChangesAsync();
        return Ok();
    }
}

public record SaveProgressRequest(Guid MangaId, Guid ChapterId, int PageIndex);
