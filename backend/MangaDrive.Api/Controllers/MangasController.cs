using System.Security.Claims;
using MangaDrive.Api.Filters;
using MangaDrive.Api.Security;
using MangaDrive.Core.DTOs;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/mangas")]
[Authorize]
[RequireApproved]
public class MangasController : ControllerBase
{
    private readonly AppDbContext _db;

    public MangasController(AppDbContext db) => _db = db;

    [HttpGet]
    public async Task<ActionResult<List<MangaDto>>> GetAll()
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var isAdmin = User.IsInRole("Admin");

        var query = _db.Mangas.Include(m => m.RootFolder).Include(m => m.Chapters).AsQueryable();

        if (!isAdmin)
        {
            query = query.Where(m => !m.IsHidden);
        }

        // Exclude linked mangas (they are merged into their primary)
        query = query.Where(m => m.LinkedMangaId == null);

        var primaryMangas = await query.Select(m => new {
            m.Id, m.Title, m.OtherTitles, m.Description, m.Author, m.Status,
            m.Genres, m.CoverImageFileId, m.BannerImageFileId, m.UpdatedAt, m.ViewCount, m.IsNSFW
        }).ToListAsync();

        // Get all linked manga IDs
        var primaryIds = primaryMangas.Select(m => m.Id).ToList();
        var linkedMangaIds = await _db.Mangas
            .Where(m => m.LinkedMangaId != null && primaryIds.Contains(m.LinkedMangaId.Value))
            .Select(m => new { m.Id, m.LinkedMangaId })
            .ToListAsync();

        // Get chapter info grouped by effective primary
        var allRelevantMangaIds = primaryIds.Concat(linkedMangaIds.Select(l => l.Id)).ToList();
        var chapterInfo = await _db.Chapters
            .Where(c => allRelevantMangaIds.Contains(c.MangaId))
            .GroupBy(c => c.MangaId)
            .Select(g => new { MangaId = g.Key, Count = g.Count(), LatestName = g.OrderByDescending(c => c.SortOrder).Select(c => c.Name).FirstOrDefault() })
            .ToListAsync();

        // Build lookup: primaryId -> all related manga IDs (self + linked)
        var linkedLookup = linkedMangaIds.ToLookup(l => l.LinkedMangaId!.Value, l => l.Id);

        // Get latest chapter per primary (highest SortOrder across all related)
        var latestChapters = await _db.Chapters
            .Where(c => allRelevantMangaIds.Contains(c.MangaId))
            .GroupBy(c => c.MangaId)
            .Select(g => new { MangaId = g.Key, MaxSort = g.Max(c => c.SortOrder), LatestName = g.OrderByDescending(c => c.SortOrder).Select(c => c.Name).FirstOrDefault(), LatestChapterNumber = g.OrderByDescending(c => c.SortOrder).Select(c => c.ChapterNumber).FirstOrDefault() })
            .ToListAsync();

        var mangas = primaryMangas.Select(m => {
            var relatedIds = new[] { m.Id }.Concat(linkedLookup[m.Id]).ToList();
            var infos = chapterInfo.Where(ci => relatedIds.Contains(ci.MangaId)).ToList();
            var totalChapters = infos.Sum(i => i.Count);
            var latest = latestChapters.Where(lc => relatedIds.Contains(lc.MangaId)).OrderByDescending(lc => lc.MaxSort).FirstOrDefault();
            return new MangaDto(m.Id, m.Title, m.OtherTitles, m.Description, m.Author, m.Status,
                m.Genres, m.CoverImageFileId, m.BannerImageFileId, totalChapters, latest?.LatestName, m.UpdatedAt, m.ViewCount, latest?.LatestChapterNumber, m.IsNSFW);
        }).ToList();

        return Ok(mangas);
    }

    [HttpGet("paginated")]
    public async Task<IActionResult> GetPaginated(
        [FromQuery] PaginationQuery pagination,
        [FromQuery] string? sort = "updated",
        [FromQuery] string? genre = null,
        [FromQuery] string? status = null)
    {
        var (page, pageSize) = pagination.Normalized();
        var isAdmin = User.IsInRole("Admin");
        var query = _db.Mangas.Include(m => m.Chapters).AsQueryable();

        if (!isAdmin) query = query.Where(m => !m.IsHidden);
        query = query.Where(m => m.LinkedMangaId == null);

        // Filter by genre (JSON contains)
        if (!string.IsNullOrEmpty(genre))
            query = query.Where(m => m.Genres.Contains(genre));

        // Filter by status
        if (!string.IsNullOrEmpty(status))
            query = query.Where(m => m.Status == status);

        // Sort
        query = sort switch
        {
            "title" => query.OrderBy(m => m.Title),
            "newest" => query.OrderByDescending(m => m.CreatedAt),
            _ => query.OrderByDescending(m => m.UpdatedAt) // "updated" default
        };

        var total = await query.CountAsync();
        var pageItems = await query
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(m => new { m.Id, m.Title, m.OtherTitles, m.Description, m.Author, m.Status, m.Genres, m.CoverImageFileId, m.BannerImageFileId, m.UpdatedAt, m.ViewCount, m.IsNSFW })
            .ToListAsync();

        // Resolve linked chapter counts
        var pageIds = pageItems.Select(m => m.Id).ToList();
        var linkedForPage = await _db.Mangas
            .Where(m => m.LinkedMangaId != null && pageIds.Contains(m.LinkedMangaId.Value))
            .Select(m => new { m.Id, m.LinkedMangaId })
            .ToListAsync();
        var linkedPageLookup = linkedForPage.ToLookup(l => l.LinkedMangaId!.Value, l => l.Id);

        var allPageMangaIds = pageIds.Concat(linkedForPage.Select(l => l.Id)).ToList();
        var pageChapterInfo = await _db.Chapters
            .Where(c => allPageMangaIds.Contains(c.MangaId))
            .GroupBy(c => c.MangaId)
            .Select(g => new { MangaId = g.Key, Count = g.Count(), MaxSort = g.Max(c => c.SortOrder), LatestName = g.OrderByDescending(c => c.SortOrder).Select(c => c.Name).FirstOrDefault(), LatestChapterNumber = g.OrderByDescending(c => c.SortOrder).Select(c => c.ChapterNumber).FirstOrDefault() })
            .ToListAsync();

        var items = pageItems.Select(m => {
            var relatedIds = new[] { m.Id }.Concat(linkedPageLookup[m.Id]).ToList();
            var infos = pageChapterInfo.Where(ci => relatedIds.Contains(ci.MangaId)).ToList();
            var totalChapters = infos.Sum(i => i.Count);
            var latest = infos.OrderByDescending(i => i.MaxSort).FirstOrDefault();
            return new MangaDto(m.Id, m.Title, m.OtherTitles, m.Description, m.Author, m.Status,
                m.Genres, m.CoverImageFileId, m.BannerImageFileId, totalChapters, latest?.LatestName, m.UpdatedAt, m.ViewCount, latest?.LatestChapterNumber, m.IsNSFW);
        }).ToList();

        return Ok(PaginatedResult<MangaDto>.Create(items, total, page, pageSize));
    }

    [HttpGet("genres")]
    public async Task<IActionResult> GetGenres()
    {
        var allGenres = await _db.Mangas
            .Where(m => m.LinkedMangaId == null && !m.IsHidden && m.Genres != "[]" && m.Genres != "")
            .Select(m => m.Genres)
            .ToListAsync();

        var genres = allGenres
            .SelectMany(g => System.Text.Json.JsonSerializer.Deserialize<List<string>>(g) ?? new())
            .GroupBy(g => g)
            .OrderByDescending(g => g.Count())
            .Select(g => g.Key)
            .ToList();

        return Ok(genres);
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<MangaDto>> Get(Guid id)
    {
        var m = await _db.Mangas.Include(x => x.Chapters).FirstOrDefaultAsync(x => x.Id == id);
        if (m == null) return NotFound();

        // Include chapter count from linked mangas
        var linkedChapterCount = await _db.Chapters
            .CountAsync(c => _db.Mangas.Any(lm => lm.LinkedMangaId == id && lm.Id == c.MangaId));
        var totalChapters = m.Chapters.Count + linkedChapterCount;

        var latestChapter = m.Chapters.OrderByDescending(c => c.SortOrder).FirstOrDefault();
        return Ok(new MangaDto(m.Id, m.Title, m.OtherTitles, m.Description, m.Author, m.Status,
            m.Genres, m.CoverImageFileId, m.BannerImageFileId, totalChapters,
            latestChapter?.Name,
            m.UpdatedAt, m.ViewCount, latestChapter?.ChapterNumber, m.IsNSFW));
    }

    [HttpGet("{id:guid}/chapters")]
    public async Task<ActionResult<List<ChapterDto>>> GetChapters(Guid id)
    {
        // Get chapters from this manga + all mangas linked to it
        var linkedIds = await _db.Mangas
            .Where(m => m.LinkedMangaId == id)
            .Select(m => m.Id)
            .ToListAsync();

        var allMangaIds = new List<Guid> { id };
        allMangaIds.AddRange(linkedIds);

        var chapters = await _db.Chapters
            .Where(c => allMangaIds.Contains(c.MangaId))
            .OrderBy(c => c.SortOrder)
            .Select(c => new ChapterDto(c.Id, c.Name, c.SortOrder, c.Images.Count, c.ChapterNumber, c.ChapterName, c.Slug))
            .ToListAsync();

        return Ok(chapters);
    }
}

[ApiController]
[Route("api/chapters")]
[Authorize]
[RequireApproved]
public class ChaptersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IConfiguration _config;

    public ChaptersController(AppDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<ChapterDetailDto>> Get(Guid id)
    {
        var chapter = await _db.Chapters.Include(c => c.Images).Include(c => c.Manga).FirstOrDefaultAsync(c => c.Id == id);
        if (chapter == null) return NotFound();
        var images = chapter.Images.OrderBy(i => i.SortOrder)
            .Select(i => new ChapterImageDto(i.Id, i.DriveFileId, i.FileName, i.SortOrder)).ToList();
        var mangaId = chapter.Manga.LinkedMangaId ?? chapter.MangaId;

        // Only tell client whether images are scrambled, never expose the key
        var isScrambled = _config.GetValue<bool>("Scramble:Enabled");

        return Ok(new ChapterDetailDto(chapter.Id, mangaId, chapter.Name, chapter.SortOrder, images, isScrambled));
    }

    /// <summary>
    /// Session-gated per-chapter scramble key. Returns the derived key
    /// HMAC-SHA256(masterKey, slug) — never the master key itself — plus the grid,
    /// for the specific chapter the authorized user is reading. Rate-limited to
    /// throttle bulk key enumeration.
    /// </summary>
    [HttpGet("{id:guid}/scramble-key")]
    [Microsoft.AspNetCore.RateLimiting.EnableRateLimiting("scramble-key")]
    public async Task<IActionResult> ScrambleKey(Guid id)
    {
        if (!_config.GetValue<bool>("Scramble:Enabled")) return NotFound();

        var chapter = await _db.Chapters.FirstOrDefaultAsync(c => c.Id == id);
        if (chapter == null) return NotFound();

        // Scrambled chapter with no slug = synced before Phase 2 / manifest missing.
        // Tell the reader clearly so it can show "chưa sẵn sàng, cần re-sync".
        if (string.IsNullOrEmpty(chapter.Slug) || chapter.Grid == null)
            return Conflict(new { code = "SLUG_MISSING", message = "Chương chưa sẵn sàng để giải mã (cần re-sync)." });

        var masterKey = _config["Scramble:MasterKey"];
        if (string.IsNullOrEmpty(masterKey))
        {
            // Misconfiguration: enabled but no server key. Don't leak details.
            return StatusCode(500, new { code = "SERVER_KEY_MISSING", message = "Máy chủ chưa cấu hình khóa giải mã." });
        }

        Response.Headers.CacheControl = "no-store";
        var key = ChapterKeyDeriver.Derive(masterKey, chapter.Slug);
        return Ok(new { key, grid = chapter.Grid });
    }

    /// <summary>Reader reports a problem with a chapter; notifies every admin.</summary>
    [HttpPost("{id:guid}/report")]
    public async Task<IActionResult> Report(Guid id, [FromBody] ReportChapterDto dto)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var user = await _db.Users.FindAsync(userId);

        var chapter = await _db.Chapters.Include(c => c.Manga).FirstOrDefaultAsync(c => c.Id == id);
        if (chapter == null) return NotFound();

        var reason = (dto.Reason ?? string.Empty).Trim();
        if (reason.Length == 0) return BadRequest(new { message = "Vui lòng mô tả lỗi" });
        if (reason.Length > 500) reason = reason[..500];

        var admins = await _db.Users
            .Where(u => u.Role == MangaDrive.Core.Entities.UserRole.Admin && !u.IsDisabled)
            .Select(u => u.Id)
            .ToListAsync();

        foreach (var adminId in admins)
        {
            _db.Notifications.Add(new MangaDrive.Core.Entities.Notification
            {
                UserId = adminId,
                Type = "chapter_report",
                Title = $"Báo lỗi: {chapter.Manga.Title} - {chapter.Name}",
                Message = $"{user?.DisplayName ?? "Người dùng"}: {reason}",
                Link = $"/chapter/{chapter.Id}"
            });
        }
        if (admins.Count > 0) await _db.SaveChangesAsync();

        return Ok(new { reported = true });
    }
}

public record ReportChapterDto(string Reason);
