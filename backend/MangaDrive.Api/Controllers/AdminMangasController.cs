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

    // Manual drag-and-drop reorder for one-off fixes (e.g. a couple of misordered
    // chapters) without needing a full paste-able name/order list. chapterIds must be
    // given newest-first (as displayed) — SortOrder is assigned in reverse so index 0
    // gets the highest value, matching the reader/UI convention (higher SortOrder = newer).
    // Manifest-backed chapters (Slug != null) are protected by default, same as
    // ImportChapters: MangaSyncService resyncs SortOrder from manifest.json on every
    // sync and would otherwise silently revert this. force bypasses that.
    [HttpPost("{mangaId:guid}/reorder-chapters")]
    public async Task<IActionResult> ReorderChapters(Guid mangaId, [FromBody] List<Guid> chapterIds, [FromQuery] bool force = false)
    {
        var manga = await _db.Mangas.FindAsync(mangaId);
        if (manga == null) return NotFound();

        var allMangaIds = new List<Guid> { mangaId };
        var linkedIds = await _db.Mangas.Where(m => m.LinkedMangaId == mangaId).Select(m => m.Id).ToListAsync();
        allMangaIds.AddRange(linkedIds);
        if (manga.LinkedMangaId != null)
        {
            var primaryId = manga.LinkedMangaId.Value;
            allMangaIds = new List<Guid> { primaryId };
            var otherLinked = await _db.Mangas.Where(m => m.LinkedMangaId == primaryId).Select(m => m.Id).ToListAsync();
            allMangaIds.AddRange(otherLinked);
        }

        // Scope to this manga's group so a chapter id from another manga can't be
        // smuggled in to have its SortOrder rewritten.
        var chapters = await _db.Chapters
            .Where(c => allMangaIds.Contains(c.MangaId) && chapterIds.Contains(c.Id))
            .ToListAsync();
        var chapterLookup = chapters.ToDictionary(c => c.Id);

        var updated = 0;
        var protectedByManifest = 0;
        for (int i = 0; i < chapterIds.Count; i++)
        {
            if (!chapterLookup.TryGetValue(chapterIds[i], out var chapter)) continue;
            if (chapter.Slug != null && !force) { protectedByManifest++; continue; }
            chapter.SortOrder = chapterIds.Count - 1 - i;
            updated++;
        }

        await _db.SaveChangesAsync();
        return Ok(new { total = chapterIds.Count, updated, protectedByManifest });
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
        // No digits at all (e.g. "Chương Oneshot - Joker") sorts last, not as chapter 0 —
        // see MangaSyncService.ExtractNumber for why falling back to 0 hid such chapters.
        return match.Success ? double.Parse(match.Value, System.Globalization.CultureInfo.InvariantCulture) : double.MaxValue;
    }

    // Merges the previously-separate "import tên" and "import thứ tự" actions into
    // one endpoint: an admin-supplied list is already both the source of truth for
    // ordering (order 1 = newest) and, once matched, for the display name — so there
    // is no separate case where only one of SortOrder/ChapterNumber/ChapterName needs
    // updating. Matches by exact Chapter.Name (trusts the imported list verbatim,
    // e.g. scraped from the original source site), which also makes a manual
    // drag-and-drop "Sắp xếp" step unnecessary once a name/order list is available.
    [HttpPost("{mangaId:guid}/import-chapters")]
    public async Task<IActionResult> ImportChapters(Guid mangaId, [FromBody] List<ImportChapterItem> items, [FromQuery] bool force = false)
    {
        var manga = await _db.Mangas.FindAsync(mangaId);
        if (manga == null) return NotFound();

        // Chapters live across this manga + everything linked to it (or, if this
        // manga is itself linked, its primary + siblings) — same scope as
        // ReorderLinkedChapters, since the chapter list is one logical sequence
        // regardless of which underlying Manga row a chapter belongs to.
        var allMangaIds = new List<Guid> { mangaId };
        var linkedIds = await _db.Mangas
            .Where(m => m.LinkedMangaId == mangaId)
            .Select(m => m.Id)
            .ToListAsync();
        allMangaIds.AddRange(linkedIds);

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
            .ToListAsync();

        var chapterByName = chapters
            .GroupBy(c => c.Name.Trim(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

        var updated = 0;
        var protectedByManifest = 0;
        // Items whose name has no matching Chapter row — these aren't in the DB yet,
        // i.e. not synced from Drive, so the caller can't have imported them for real.
        // Surfaced back to the admin (as a downloadable list) instead of just a count,
        // so they know exactly which chapters still need a Drive sync first.
        var unsynced = new List<UnsyncedChapterItem>();
        foreach (var item in items)
        {
            var name = item.Name?.Trim();
            if (string.IsNullOrEmpty(name) || !chapterByName.TryGetValue(name, out var chapter))
            {
                unsynced.Add(new UnsyncedChapterItem(item.Name, item.Order));
                continue;
            }

            // Manifest-backed chapters (scrambled uploads) get their Name/ChapterNumber/
            // ChapterName/SortOrder from manifest.json on every sync (see MangaSyncService),
            // so overwriting them here would just get reverted on the next sync anyway —
            // skip them instead of silently no-op'ing via the name-mismatch path above.
            // `force` bypasses this: used to one-time repair a manga whose manifest.json
            // itself has bad ordering (e.g. two overlapping append batches) — the admin
            // is explicitly asserting the pasted list is more correct than the manifest.
            if (chapter.Slug != null && !force)
            {
                protectedByManifest++;
                continue;
            }

            // order 1 = newest chapter, so SortOrder runs the opposite direction
            // (higher SortOrder = newer, matching the rest of the reader/UI).
            chapter.SortOrder = items.Count - item.Order;
            chapter.ChapterNumber = ExtractChapterNumberString(name);
            chapter.ChapterName = ExtractChapterName(name);
            updated++;
        }

        await _db.SaveChangesAsync();
        return Ok(new { total = items.Count, updated, protectedByManifest, skipped = unsynced.Count, unsynced });
    }

    /// <summary>
    /// Extract chapter number string from a chapter name, e.g. "Chương 881: ..." -> "881",
    /// "Ch.5.5 — ..." -> "5.5". A name with no digits (e.g. a oneshot) yields null.
    /// </summary>
    private static string? ExtractChapterNumberString(string name)
    {
        var match = System.Text.RegularExpressions.Regex.Match(name, @"(\d+\.?\d*)");
        return match.Success ? match.Groups[1].Value : null;
    }

    /// <summary>
    /// Extract chapter display name from a chapter name after separator (— or – or : or -)
    /// "Chương 881: Trở về" -> "Trở về"
    /// "Ch.1 — Tên chapter" -> "Tên chapter"
    /// </summary>
    private static string? ExtractChapterName(string name)
    {
        var separators = new[] { " — ", " – ", " - ", ": " };
        foreach (var sep in separators)
        {
            var idx = name.IndexOf(sep, StringComparison.Ordinal);
            if (idx >= 0)
            {
                var result = name[(idx + sep.Length)..].Trim();
                return string.IsNullOrEmpty(result) ? null : result;
            }
        }
        return null;
    }
}

public record LinkMangaRequest(Guid TargetMangaId);
public record ImportChapterItem(string Name, int Order);
public record UnsyncedChapterItem(string? Name, int Order);
public record UpdateTitleRequest(string Title);
