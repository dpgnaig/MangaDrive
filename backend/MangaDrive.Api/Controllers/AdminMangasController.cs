using MangaDrive.Api.Filters;
using MangaDrive.Infrastructure.Data;
using MangaDrive.Infrastructure.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/admin/mangas")]
[Authorize]
[RequireAdmin]
public class AdminMangasController : ControllerBase
{
    private readonly AppDbContext _db;

    public AdminMangasController(AppDbContext db) => _db = db;

    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var mangas = await _db.Mangas.Include(m => m.RootFolder)
            .Select(m => new { m.Id, m.Title, m.IsHidden, m.RootFolderId, RootFolderName = m.RootFolder.Name, m.LinkedMangaId })
            .ToListAsync();
        return Ok(mangas);
    }

    [HttpPost("{id:guid}/sync")]
    public async Task<IActionResult> SyncManga(Guid id)
    {
        var manga = await _db.Mangas.FindAsync(id);
        if (manga == null) return NotFound();
        await SyncBackgroundService.Queue.Writer.WriteAsync(new SyncRequest(id, SyncRequestType.Manga));
        return Accepted();
    }

    [HttpPost("{id:guid}/toggle-visibility")]
    public async Task<IActionResult> ToggleVisibility(Guid id)
    {
        var manga = await _db.Mangas.FindAsync(id);
        if (manga == null) return NotFound();
        manga.IsHidden = !manga.IsHidden;
        await _db.SaveChangesAsync();
        return Ok(new { manga.IsHidden });
    }

    // Lets an admin correct the display title before running metadata search — useful
    // when the Drive folder name has noise (release group tags, language markers) that
    // throws off AniList/MangaDex matching. Only touches Title; the metadata-apply flow
    // (AdminMetadataController) remains the path for updating every other field at once.
    [HttpPatch("{id:guid}/title")]
    public async Task<IActionResult> UpdateTitle(Guid id, [FromBody] UpdateTitleRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Title)) return BadRequest(new { message = "Tên manga không được để trống" });

        var manga = await _db.Mangas.FindAsync(id);
        if (manga == null) return NotFound();

        manga.Title = req.Title.Trim();
        manga.UpdatedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return Ok(new { manga.Id, manga.Title });
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id)
    {
        var manga = await _db.Mangas.FindAsync(id);
        if (manga == null) return NotFound();

        // Check if this manga is a primary (other mangas linked to it)
        var linkedMangas = await _db.Mangas.Where(m => m.LinkedMangaId == id).ToListAsync();
        if (linkedMangas.Count > 0)
        {
            // Promote first linked manga to become the new primary
            var newPrimary = linkedMangas[0];
            newPrimary.LinkedMangaId = null;

            // Point remaining linked mangas to new primary
            for (int i = 1; i < linkedMangas.Count; i++)
            {
                linkedMangas[i].LinkedMangaId = newPrimary.Id;
            }

            await _db.SaveChangesAsync();
        }

        // Remove related data (non-cascade tables or explicit cleanup)
        var chapters = await _db.Chapters.Where(c => c.MangaId == id).ToListAsync();
        foreach (var ch in chapters)
            _db.ChapterImages.RemoveRange(_db.ChapterImages.Where(ci => ci.ChapterId == ch.Id));
        _db.Chapters.RemoveRange(chapters);

        _db.Comments.RemoveRange(_db.Comments.Where(c => c.MangaId == id));
        _db.Favorites.RemoveRange(_db.Favorites.Where(f => f.MangaId == id));
        _db.ReadingHistories.RemoveRange(_db.ReadingHistories.Where(r => r.MangaId == id));
        _db.UserMangaPermissions.RemoveRange(_db.UserMangaPermissions.Where(p => p.MangaId == id));
        _db.Mangas.Remove(manga);

        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPost("{mangaId:guid}/reorder-chapters")]
    public async Task<IActionResult> ReorderChapters(Guid mangaId, [FromBody] List<Guid> chapterIds)
    {
        var chapters = await _db.Chapters.Where(c => c.MangaId == mangaId).ToListAsync();
        for (int i = 0; i < chapterIds.Count; i++)
        {
            var ch = chapters.FirstOrDefault(c => c.Id == chapterIds[i]);
            if (ch != null) ch.SortOrder = i;
        }
        await _db.SaveChangesAsync();
        return Ok();
    }

    [HttpPost("{id:guid}/link")]
    public async Task<IActionResult> LinkManga(Guid id, [FromBody] LinkMangaRequest req)
    {
        var manga = await _db.Mangas.FindAsync(id);
        if (manga == null) return NotFound();

        var target = await _db.Mangas.FindAsync(req.TargetMangaId);
        if (target == null) return BadRequest("Target manga not found");

        // Prevent linking to itself
        if (id == req.TargetMangaId) return BadRequest("Cannot link manga to itself");

        // Prevent linking to a manga that is itself linked (only link to primary)
        if (target.LinkedMangaId != null) return BadRequest("Target manga is already linked to another. Link to the primary instead.");

        manga.LinkedMangaId = req.TargetMangaId;
        await _db.SaveChangesAsync();

        // Reorder all chapters (primary + all linked) by extracted number from name
        await ReorderLinkedChapters(req.TargetMangaId);

        return Ok(new { manga.Id, manga.LinkedMangaId });
    }

    [HttpDelete("{id:guid}/link")]
    public async Task<IActionResult> UnlinkManga(Guid id)
    {
        var manga = await _db.Mangas.FindAsync(id);
        if (manga == null) return NotFound();

        var previousPrimaryId = manga.LinkedMangaId;
        manga.LinkedMangaId = null;
        await _db.SaveChangesAsync();

        // Reorder the unlinked manga's own chapters (reset to 0-based)
        var chapters = await _db.Chapters.Where(c => c.MangaId == id).OrderBy(c => c.SortOrder).ToListAsync();
        for (int i = 0; i < chapters.Count; i++) chapters[i].SortOrder = i;
        await _db.SaveChangesAsync();

        // Reorder primary's remaining chapters
        if (previousPrimaryId != null)
            await ReorderLinkedChapters(previousPrimaryId.Value);

        return NoContent();
    }

    [HttpGet("linkable")]
    public async Task<IActionResult> GetLinkable()
    {
        // Return all primary mangas (not linked to anything) for selection
        var mangas = await _db.Mangas
            .Where(m => m.LinkedMangaId == null)
            .Select(m => new { m.Id, m.Title, m.CoverImageFileId })
            .OrderBy(m => m.Title)
            .ToListAsync();
        return Ok(mangas);
    }

    private async Task ReorderLinkedChapters(Guid primaryMangaId)
    {
        var linkedIds = await _db.Mangas
            .Where(m => m.LinkedMangaId == primaryMangaId)
            .Select(m => m.Id)
            .ToListAsync();

        var allMangaIds = new List<Guid> { primaryMangaId };
        allMangaIds.AddRange(linkedIds);

        var chapters = await _db.Chapters
            .Where(c => allMangaIds.Contains(c.MangaId))
            .ToListAsync();

        // Prefer ManifestOrder (natural-sort position recorded at scramble time —
        // see MangaSyncService.ReorderLinkedChapters for why this is more trustworthy
        // than parsing a number out of Name once chapter names get inconsistent).
        // Falls back to ExtractNumber for chapters never scrambled, or scrambled
        // before this field existed.
        var sorted = chapters
            .OrderBy(c => c.ManifestOrder ?? (int)ExtractNumber(c.Name))
            .ThenBy(c => c.Name)
            .ToList();

        for (int i = 0; i < sorted.Count; i++)
        {
            sorted[i].SortOrder = i;
        }

        await _db.SaveChangesAsync();
    }

    private static double ExtractNumber(string name)
    {
        var match = System.Text.RegularExpressions.Regex.Match(name, @"(\d+\.?\d*)");
        return match.Success ? double.Parse(match.Value, System.Globalization.CultureInfo.InvariantCulture) : 0;
    }

    [HttpPost("{mangaId:guid}/import-chapter-names")]
    public async Task<IActionResult> ImportChapterNames(Guid mangaId, [FromBody] List<ImportChapterNameItem> items)
    {
        var manga = await _db.Mangas.FindAsync(mangaId);
        if (manga == null) return NotFound();

        // Get all chapters for this manga + linked mangas
        var allMangaIds = new List<Guid> { mangaId };
        var linkedIds = await _db.Mangas
            .Where(m => m.LinkedMangaId == mangaId)
            .Select(m => m.Id)
            .ToListAsync();
        allMangaIds.AddRange(linkedIds);

        // Also check if this manga is itself linked to a primary
        if (manga.LinkedMangaId != null)
        {
            var primaryId = manga.LinkedMangaId.Value;
            allMangaIds = new List<Guid> { primaryId };
            var otherLinked = await _db.Mangas
                .Where(m => m.LinkedMangaId == primaryId)
                .Select(m => m.Id)
                .ToListAsync();
            allMangaIds.AddRange(otherLinked);
        }

        var chapters = await _db.Chapters
            .Where(c => allMangaIds.Contains(c.MangaId))
            .OrderBy(c => c.SortOrder)
            .ToListAsync();

        // Build lookup: chapter number -> chapter entity
        var chapterByNumber = chapters
            .Select(c => new { Chapter = c, Number = ExtractNumber(c.Name) })
            .GroupBy(x => x.Number)
            .ToDictionary(g => g.Key, g => g.First().Chapter);

        // Parse each label: "Ch.1 — Tên chapter" or "Ch.1: Tên chapter"
        var updated = 0;
        foreach (var item in items)
        {
            var number = ExtractNumber(item.Label);
            if (chapterByNumber.TryGetValue(number, out var chapter))
            {
                // Extract chapter number string and chapter name from label
                var chapterNumber = ExtractChapterNumberString(item.Label);
                var chapterName = ExtractChapterName(item.Label);

                chapter.ChapterNumber = chapterNumber;
                chapter.ChapterName = chapterName;
                updated++;
            }
        }

        await _db.SaveChangesAsync();
        return Ok(new { total = items.Count, updated, skipped = items.Count - updated });
    }

    /// <summary>
    /// Extract chapter number string from label, e.g. "Ch.1 — ..." -> "1", "Ch.5.5 — ..." -> "5.5"
    /// </summary>
    private static string? ExtractChapterNumberString(string label)
    {
        var match = System.Text.RegularExpressions.Regex.Match(label, @"Ch\.?\s*(\d+\.?\d*)");
        return match.Success ? match.Groups[1].Value : null;
    }

    /// <summary>
    /// Extract chapter name from label after separator (— or : or -)
    /// "Ch.1 — Tên chapter" -> "Tên chapter"
    /// "Ch.1: Tên chapter" -> "Tên chapter"
    /// </summary>
    private static string? ExtractChapterName(string label)
    {
        // Try separators: " — ", " - ", ": "
        var separators = new[] { " — ", " — ", " - ", ": " };
        foreach (var sep in separators)
        {
            var idx = label.IndexOf(sep);
            if (idx >= 0)
            {
                var name = label[(idx + sep.Length)..].Trim();
                return string.IsNullOrEmpty(name) ? null : name;
            }
        }
        return null;
    }
}

public record LinkMangaRequest(Guid TargetMangaId);
public record ImportChapterNameItem(string Label);
public record UpdateTitleRequest(string Title);
