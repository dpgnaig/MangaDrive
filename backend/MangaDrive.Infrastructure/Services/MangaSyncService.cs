using System.Text.Json;
using System.Text.RegularExpressions;
using MangaDrive.Core.Entities;
using MangaDrive.Core.Interfaces;
using MangaDrive.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace MangaDrive.Infrastructure.Services;

public class MangaSyncService : IMangaSyncService
{
    private readonly AppDbContext _db;
    private readonly IGoogleDriveService _drive;
    private readonly ISyncNotifier _notifier;
    private readonly ILogger<MangaSyncService> _logger;

    // Matches current 12-hex slugs and legacy `chapter-` prefixed slugs. Used to
    // detect a checkpoint-upload race before manifest.json contains the folder entry.
    private static readonly Regex ScrambleSlugPattern = new(@"^(?:chapter-)?[0-9a-f]{12}$", RegexOptions.Compiled);

    public MangaSyncService(AppDbContext db, IGoogleDriveService drive,
        ISyncNotifier notifier, ILogger<MangaSyncService> logger)
    {
        _db = db;
        _drive = drive;
        _notifier = notifier;
        _logger = logger;
    }

    public async Task SyncRootFolderAsync(Guid rootFolderId, CancellationToken ct = default)
    {
        var rootFolder = await _db.RootFolders.FindAsync([rootFolderId], ct)
            ?? throw new Exception("Root folder not found");

        var job = new SyncJob { RootFolderId = rootFolderId, Status = "Running" };
        _db.SyncJobs.Add(job);
        await _db.SaveChangesAsync(ct);

        try
        {
            var mangaFolders = await _drive.ListFoldersAsync(rootFolder.GoogleDriveFolderId);
            job.TotalManga = mangaFolders.Count;
            await SaveAndNotify(job, rootFolder.Name);

            foreach (var mf in mangaFolders)
            {
                ct.ThrowIfCancellationRequested();
                job.CurrentManga = mf.Name;
                await SaveAndNotify(job, rootFolder.Name);

                var manga = await _db.Mangas.FirstOrDefaultAsync(m => m.DriveFileId == mf.Id, ct);
                if (manga == null)
                {
                    manga = new Manga { RootFolderId = rootFolderId, DriveFileId = mf.Id, Title = mf.Name };
                    _db.Mangas.Add(manga);
                }

                var newChapters = await SyncMangaFolder(manga, job, rootFolder.Name, ct);

                // Notify members who favorited this manga
                if (newChapters > 0)
                {
                    await NotifyMembersNewChapters(manga.Id, manga.LinkedMangaId, manga.Title, newChapters, ct);
                }

                job.SyncedManga++;
                await SaveAndNotify(job, rootFolder.Name);
            }

            // Cleanup: remove manga that no longer exist on Drive
            var driveMangaIds = mangaFolders.Select(f => f.Id).ToHashSet();
            var staleManga = await _db.Mangas.Where(m => m.RootFolderId == rootFolderId && !driveMangaIds.Contains(m.DriveFileId)).ToListAsync(ct);
            foreach (var sm in staleManga)
            {
                var chapters = await _db.Chapters.Where(c => c.MangaId == sm.Id).ToListAsync(ct);
                foreach (var ch in chapters)
                    _db.ChapterImages.RemoveRange(_db.ChapterImages.Where(ci => ci.ChapterId == ch.Id));
                _db.Chapters.RemoveRange(chapters);
                _db.Comments.RemoveRange(_db.Comments.Where(c => c.MangaId == sm.Id));
            }
            _db.Mangas.RemoveRange(staleManga);
            await _db.SaveChangesAsync(ct);

            job.Status = "Completed";
            job.CompletedAt = DateTime.UtcNow;
            job.Message = "Sync completed successfully";

            // Update the Changes page token so AutoSync starts from current state
            try
            {
                rootFolder.ChangesPageToken = await _drive.GetStartPageTokenAsync();
                rootFolder.LastSyncedAt = DateTime.UtcNow;
            }
            catch { /* non-critical */ }
        }
        catch (Exception ex)
        {
            job.Status = "Failed";
            job.Message = ex.Message;
            _db.SyncJobLogs.Add(new SyncJobLog { SyncJobId = job.Id, Level = "Error", Message = ex.Message });
            _logger.LogError(ex, "Sync failed for root folder {Id}", rootFolderId);
        }

        job.CompletedAt ??= DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        await SaveAndNotify(job, rootFolder.Name);
    }

    public async Task SyncSingleMangaAsync(Guid mangaId, CancellationToken ct = default)
    {
        var manga = await _db.Mangas.Include(m => m.RootFolder).FirstOrDefaultAsync(m => m.Id == mangaId, ct)
            ?? throw new Exception("Manga not found");

        var rootFolder = manga.RootFolder;
        var job = new SyncJob { RootFolderId = rootFolder.Id, Status = "Running", TotalManga = 1 };
        _db.SyncJobs.Add(job);
        await _db.SaveChangesAsync(ct);

        try
        {
            job.CurrentManga = manga.Title;
            await SaveAndNotify(job, rootFolder.Name);

            var newChapters = await SyncMangaFolder(manga, job, rootFolder.Name, ct);

            job.SyncedManga = 1;
            job.Status = "Completed";
            job.CompletedAt = DateTime.UtcNow;
            job.Message = $"Sync '{manga.Title}' completed";

            // Notify members who favorited this manga
            if (newChapters > 0)
            {
                await NotifyMembersNewChapters(manga.Id, manga.LinkedMangaId, manga.Title, newChapters, ct);
            }
        }
        catch (Exception ex)
        {
            job.Status = "Failed";
            job.Message = ex.Message;
            _db.SyncJobLogs.Add(new SyncJobLog { SyncJobId = job.Id, Level = "Error", Message = ex.Message });
            _logger.LogError(ex, "Sync failed for manga {Id}", mangaId);
        }

        job.CompletedAt ??= DateTime.UtcNow;
        await _db.SaveChangesAsync(ct);
        await SaveAndNotify(job, rootFolder.Name);
    }

    /// <summary>
    /// Sync a single manga folder: metadata, chapters, images.
    /// Shared by both SyncRootFolderAsync and SyncSingleMangaAsync.
    /// Returns number of new chapters added.
    /// </summary>
    private async Task<int> SyncMangaFolder(Manga manga, SyncJob job, string rootName, CancellationToken ct)
    {
        int newChapterCount = 0;

        // Read metadata and cover
        var files = await _drive.ListFilesAsync(manga.DriveFileId);
        await ApplyMetadata(manga, files);
        await _db.SaveChangesAsync(ct);

        // Auto-link: if another manga with same title exists as primary, link to it
        if (manga.LinkedMangaId == null)
        {
            var existingPrimary = await _db.Mangas.FirstOrDefaultAsync(m =>
                m.Id != manga.Id &&
                m.Title == manga.Title &&
                m.LinkedMangaId == null, ct);

            if (existingPrimary != null)
            {
                // This manga becomes linked to the existing primary
                manga.LinkedMangaId = existingPrimary.Id;
                await _db.SaveChangesAsync(ct);
                _logger.LogInformation("Auto-linked \"{Title}\" ({Id}) → primary ({PrimaryId})", manga.Title, manga.Id, existingPrimary.Id);
            }
        }

        // Per-chapter scramble manifest: Drive folders use opaque slugs, while the
        // real chapter name, number, grid and ordering live in manifest.json.
        // Map the exact slug (including any legacy prefix) to its entry.
        var scrambleManifest = await ReadScrambleManifest(files, manga.Id, ct);

        // Sync chapters. Prefer the manifest's Order (natural-sort position recorded
        // at scramble time) — parsing a number out of Original/the folder name is
        // only a fallback for legacy manifests/entries that predate the Order field,
        // since that parsing is unreliable once names get inconsistent (and used to
        // throw OverflowException on names with very long digit runs).
        var chapterFolders = (await _drive.ListFoldersAsync(manga.DriveFileId))
            .OrderBy(f =>
            {
                scrambleManifest.TryGetValue(f.Name, out var e);
                return e?.Order ?? ExtractNumber(e?.Original ?? f.Name);
            })
            .ToList();
        _syncedChaptersBeforeCurrentManga = job.SyncedChapter;
        _currentMangaChapterCount = chapterFolders.Count;
        _currentMangaNewChapters = 0;
        _currentMangaId = manga.LinkedMangaId ?? manga.Id; // Use primary ID for display
        bool hasAnyContentChange = false;
        job.TotalChapter += chapterFolders.Count;
        await SaveAndNotify(job, rootName);

        for (int i = 0; i < chapterFolders.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var cf = chapterFolders[i];
            job.CurrentChapter = cf.Name;
            await SaveAndNotify(job, rootName);

            // For scrambled uploads the Drive folder is named by slug; the human
            // chapter name/number lives in the manifest entry. Fall back to the
            // folder name for legacy (unscrambled) folders with no manifest.
            scrambleManifest.TryGetValue(cf.Name, out var manifestEntry);

            // A slug-named folder with no manifest entry means the checkpoint
            // upload (AdminScrambleTab.tsx) created the Drive folder but hasn't
            // PATCHed manifest.json yet — sync ran mid-upload. Skip this folder
            // for now instead of falling back to the raw slug as a display name
            // (which regexes into a meaningless "chapter number"); the next sync
            // pass will see the completed manifest and pick it up correctly.
            if (manifestEntry == null && ScrambleSlugPattern.IsMatch(cf.Name))
            {
                job.SyncedChapter++;
                await SaveAndNotify(job, rootName);
                continue;
            }

            var displayName = manifestEntry?.Original ?? cf.Name;

            var chapter = await _db.Chapters.FirstOrDefaultAsync(
                c => c.MangaId == manga.Id && c.DriveFileId == cf.Id, ct);
            if (chapter == null)
            {
                chapter = new Chapter
                {
                    MangaId = manga.Id,
                    DriveFileId = cf.Id,
                    Name = displayName,
                    ChapterNumber = ExtractChapterNumber(displayName),
                    ChapterName = ExtractChapterName(displayName),
                    Slug = manifestEntry?.Slug,
                    Grid = manifestEntry?.Grid,
                    ManifestOrder = manifestEntry?.Order,
                    SortOrder = i
                };
                _db.Chapters.Add(chapter);
                await _db.SaveChangesAsync(ct);
                newChapterCount++;
                _currentMangaNewChapters++;
            }
            else
            {
                // This chapter was previously created by the fallback path above
                // (manifest missed it at the time, so it was named/numbered from
                // the raw slug) and the manifest now has a real entry for it —
                // self-heal the name/number/order using the now-complete manifest.
                // A chapter with no manifest (never scrambled) always has
                // manifestEntry == null, so this never touches non-scrambled chapters.
                var wasCreatedFromFallback = chapter.Slug == null && manifestEntry != null;
                if (wasCreatedFromFallback)
                {
                    chapter.Name = displayName;
                    chapter.SortOrder = i;
                }

                // Backfill: if existing chapter has no ChapterNumber, extract from Name
                if (chapter.ChapterNumber == null || wasCreatedFromFallback)
                {
                    chapter.ChapterNumber = ExtractChapterNumber(chapter.Name);
                    chapter.ChapterName = ExtractChapterName(chapter.Name);
                }
                // Backfill scramble slug/grid/order on re-sync for chapters synced
                // before Phase 2, or re-uploaded with the manifest present.
                if (manifestEntry != null)
                {
                    if (chapter.Slug == null) chapter.Slug = manifestEntry.Slug;
                    if (chapter.Grid == null) chapter.Grid = manifestEntry.Grid;
                    if (chapter.ManifestOrder == null) chapter.ManifestOrder = manifestEntry.Order;
                }
            }

            // Sync images
            var images = await _drive.ListFilesAsync(cf.Id);
            var imgFiles = images.Where(f => f.MimeType.StartsWith("image/"))
                .OrderBy(f => ExtractNumber(f.Name)).ToList();
            job.TotalImage += imgFiles.Count;

            bool chapterHasImageChanges = false;
            foreach (var (img, idx) in imgFiles.Select((v, i) => (v, i)))
            {
                var exists = await _db.ChapterImages.AnyAsync(
                    ci => ci.ChapterId == chapter.Id && ci.DriveFileId == img.Id, ct);
                if (!exists)
                {
                    _db.ChapterImages.Add(new ChapterImage
                    {
                        ChapterId = chapter.Id,
                        DriveFileId = img.Id,
                        FileName = img.Name,
                        MimeType = img.MimeType,
                        SortOrder = idx
                    });
                    chapterHasImageChanges = true;
                }
                job.SyncedImage++;
            }

            // Cleanup stale images
            var driveImgIds = imgFiles.Select(f => f.Id).ToHashSet();
            var staleImages = _db.ChapterImages.Where(ci => ci.ChapterId == chapter.Id && !driveImgIds.Contains(ci.DriveFileId));
            if (await staleImages.AnyAsync(ct))
            {
                _db.ChapterImages.RemoveRange(staleImages);
                chapterHasImageChanges = true;
            }

            if (chapterHasImageChanges) hasAnyContentChange = true;

            await _db.SaveChangesAsync(ct);
            job.SyncedChapter++;
            await SaveAndNotify(job, rootName);
        }

        // Cleanup stale chapters
        var driveChapterIds = chapterFolders.Select(f => f.Id).ToHashSet();
        var staleChapters = await _db.Chapters.Where(c => c.MangaId == manga.Id && !driveChapterIds.Contains(c.DriveFileId)).ToListAsync(ct);
        foreach (var sc in staleChapters)
            _db.ChapterImages.RemoveRange(_db.ChapterImages.Where(ci => ci.ChapterId == sc.Id));
        _db.Chapters.RemoveRange(staleChapters);

        // Only update timestamp when new chapters are added — use latest chapter's modification time from Drive
        if (newChapterCount > 0)
        {
            var latestChapterTime = chapterFolders
                .Where(f => f.ModifiedTime.HasValue)
                .Max(f => f.ModifiedTime)
                ?? chapterFolders
                    .Where(f => f.CreatedTime.HasValue)
                    .Max(f => f.CreatedTime);
            manga.UpdatedAt = latestChapterTime ?? DateTime.UtcNow;
        }
        else if (hasAnyContentChange)
        {
            // Content changed (images added/removed) but no new chapters — update timestamp to now
            manga.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync(ct);

        // Reorder chapters if this manga is linked
        var primaryId = manga.LinkedMangaId ?? manga.Id;
        var hasLinks = await _db.Mangas.AnyAsync(m => m.LinkedMangaId == primaryId, ct);
        if (manga.LinkedMangaId != null || hasLinks)
        {
            await ReorderLinkedChapters(primaryId, ct);
        }

        return newChapterCount;
    }

    private async Task ReorderLinkedChapters(Guid primaryMangaId, CancellationToken ct)
    {
        var linkedIds = await _db.Mangas
            .Where(m => m.LinkedMangaId == primaryMangaId)
            .Select(m => m.Id)
            .ToListAsync(ct);

        var allMangaIds = new List<Guid> { primaryMangaId };
        allMangaIds.AddRange(linkedIds);

        var chapters = await _db.Chapters
            .Where(c => allMangaIds.Contains(c.MangaId))
            .ToListAsync(ct);

        var sorted = chapters
            .OrderBy(c => c.ManifestOrder ?? ExtractNumber(c.Name))
            .ThenBy(c => c.Name)
            .ToList();

        for (int i = 0; i < sorted.Count; i++)
            sorted[i].SortOrder = i;

        await _db.SaveChangesAsync(ct);
    }

    private async Task ApplyMetadata(Manga manga, List<DriveFile> files)
    {
        var metadataFile = files.FirstOrDefault(f => f.Name == "metadata.json");
        if (metadataFile != null)
        {
            try
            {
                var json = await _drive.GetFileContentAsync(metadataFile.Id);
                if (json != null)
                {
                    var meta = JsonSerializer.Deserialize<MangaMetadata>(json,
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                    if (meta != null)
                    {
                        manga.Title = meta.Title ?? manga.Title;
                        manga.OtherTitles = ParseOtherTitles(meta.OtherTitles);
                        manga.Description = meta.Description ?? string.Empty;
                        manga.Author = meta.Artist != null ? $"{meta.Author ?? ""} / {meta.Artist}" : (meta.Author ?? string.Empty);
                        manga.Status = meta.Status ?? string.Empty;
                        manga.Genres = meta.Genres != null ? JsonSerializer.Serialize(meta.Genres) : "[]";

                        if (meta.Cover != null)
                        {
                            var coverFile = files.FirstOrDefault(f => f.Name == meta.Cover);
                            if (coverFile != null) manga.CoverImageFileId = coverFile.Id;
                        }

                        if (meta.Banner != null)
                        {
                            var bannerFile = files.FirstOrDefault(f => f.Name == meta.Banner);
                            if (bannerFile != null) manga.BannerImageFileId = bannerFile.Id;
                        }
                    }
                }
            }
            catch { /* Invalid metadata - skip */ }
        }

        // Cover priority fallback
        if (string.IsNullOrEmpty(manga.CoverImageFileId))
        {
            var coverNames = new[] { "cover.jpg", "cover.png", "thumbnail.jpg" };
            foreach (var name in coverNames)
            {
                var f = files.FirstOrDefault(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (f != null) { manga.CoverImageFileId = f.Id; break; }
            }
        }

        // Banner priority fallback
        if (string.IsNullOrEmpty(manga.BannerImageFileId))
        {
            var bannerNames = new[] { "banner.jpg", "banner.png" };
            foreach (var name in bannerNames)
            {
                var f = files.FirstOrDefault(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
                if (f != null) { manga.BannerImageFileId = f.Id; break; }
            }
        }

        manga.UpdatedAt = manga.UpdatedAt == default ? DateTime.UtcNow : manga.UpdatedAt;
    }

    // Order: natural-sort position of this chapter in the input folder at scramble
    // time, written by AdminScrambleTab.tsx / the desktop scramble tool. Sync
    // prefers this over parsing a number out of Original — parsing broke on chapter
    // names with very long digit runs (OverflowException) and can't be trusted once
    // names get inconsistent. Nullable so manifests written before this field
    // existed (or entries missing it) still parse and fall back to ExtractNumber.
    private record ScrambleManifestEntry(string Original, string Slug, int Grid, int FileCount, int? Order = null);

    /// <summary>
    /// Read the scramble manifest.json at the manga folder root (written by the
    /// scramble tools). Returns a map keyed by slug — the Drive folder for each
    /// scrambled chapter is named by its slug, so sync looks entries up by folder
    /// name. Returns an empty map for legacy (unscrambled) mangas with no manifest.
    /// </summary>
    private async Task<Dictionary<string, ScrambleManifestEntry>> ReadScrambleManifest(
        List<DriveFile> files, Guid mangaId, CancellationToken ct)
    {
        var manifestFile = files.FirstOrDefault(f => f.Name == "manifest.json");
        if (manifestFile == null) return new();

        try
        {
            var json = await _drive.GetFileContentAsync(manifestFile.Id);
            if (string.IsNullOrEmpty(json)) return new();

            var entries = JsonSerializer.Deserialize<List<ScrambleManifestEntry>>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
            return entries
                .Where(e => !string.IsNullOrEmpty(e.Slug))
                .GroupBy(e => e.Slug)
                .ToDictionary(g => g.Key, g => g.First());
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read scramble manifest for manga {Id}", mangaId);
            return new();
        }
    }

    private int _currentMangaChapterCount;
    private int _syncedChaptersBeforeCurrentManga;
    private int _currentMangaNewChapters;
    private Guid? _currentMangaId;

    private async Task SaveAndNotify(SyncJob job, string rootName)
    {
        await _db.SaveChangesAsync();

        int percent;
        if (job.TotalManga <= 0)
        {
            percent = 0;
        }
        else if (job.Status == "Completed")
        {
            percent = 100;
        }
        else
        {
            // Each manga gets equal share of progress
            double perManga = 100.0 / job.TotalManga;
            double completed = job.SyncedManga * perManga;

            // Sub-progress within current manga based on its own chapter count
            if (_currentMangaChapterCount > 0)
            {
                var syncedInCurrent = job.SyncedChapter - _syncedChaptersBeforeCurrentManga;
                completed += ((double)syncedInCurrent / _currentMangaChapterCount) * perManga;
            }

            percent = Math.Clamp((int)completed, 0, 99);
        }

        await _notifier.NotifyProgress(new
        {
            syncJobId = job.Id,
            rootFolderId = job.RootFolderId,
            rootName,
            status = job.Status,
            currentManga = job.CurrentManga,
            currentMangaId = _currentMangaId,
            currentChapter = job.CurrentChapter,
            totalManga = job.TotalManga,
            syncedManga = job.SyncedManga,
            totalChapter = job.TotalChapter,
            syncedChapter = job.SyncedChapter,
            totalImage = job.TotalImage,
            syncedImage = job.SyncedImage,
            currentMangaTotalChapter = _currentMangaChapterCount,
            currentMangaSyncedChapter = job.SyncedChapter - _syncedChaptersBeforeCurrentManga,
            currentMangaNewChapters = _currentMangaNewChapters,
            percent,
            message = job.Message ?? $"Syncing {job.CurrentManga} / {job.CurrentChapter}"
        });
    }

    private record MangaMetadata(string? Title, JsonElement? OtherTitles, string? Description, string? Author, string? Artist, string? Status, List<string>? Genres, List<string>? Themes, string? Demographic, string? Cover, string? Banner);

    private record TitleWithLang(string Lang, string Title);

    /// <summary>
    /// Parse otherTitles which can be either:
    /// - ["title1", "title2"] (legacy)
    /// - [{"lang": "ja", "title": "タイトル"}] (new format)
    /// Always stores as JSON array of {lang, title} objects.
    /// </summary>
    private static string ParseOtherTitles(JsonElement? otherTitles)
    {
        if (otherTitles == null || otherTitles.Value.ValueKind == JsonValueKind.Null)
            return "[]";

        var result = new List<TitleWithLang>();
        foreach (var item in otherTitles.Value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                // Legacy: plain string
                result.Add(new TitleWithLang("", item.GetString()!));
            }
            else if (item.ValueKind == JsonValueKind.Object)
            {
                // New format: {lang, title}
                var lang = item.TryGetProperty("lang", out var l) ? l.GetString() ?? "" : "";
                var title = item.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "";
                if (!string.IsNullOrEmpty(title))
                    result.Add(new TitleWithLang(lang, title));
            }
        }
        return JsonSerializer.Serialize(result, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
    }

    // A name/number too long to fit Int32 (e.g. a stray long digit run in a folder
    // name) used to throw OverflowException here and crash the whole sync job.
    // TryParse + fallback to MaxValue means such a chapter just sorts last instead.
    private static int ExtractNumber(string name)
    {
        var match = Regex.Match(name, @"\d+");
        if (!match.Success) return 0;
        return int.TryParse(match.Value, out var n) ? n : int.MaxValue;
    }

    /// <summary>
    /// Extract chapter number from folder name — simply gets the first number found.
    /// "Chương 123" -> "123", "Ch.5.5 — Tên" -> "5.5", "Chuong 10" -> "10", "Chapter 1" -> "1"
    /// </summary>
    private static string? ExtractChapterNumber(string name)
    {
        var match = Regex.Match(name, @"(\d+\.?\d*)");
        return match.Success ? match.Groups[1].Value : null;
    }

    /// <summary>
    /// Extract chapter name from folder name after separator (— or - or :).
    /// "Ch.236 — Về phương Nam" -> "Về phương Nam"
    /// "Chapter 1" -> null
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

    private async Task NotifyMembersNewChapters(Guid mangaId, Guid? linkedMangaId, string mangaTitle, int newCount, CancellationToken ct)
    {
        // Determine the primary manga ID (for linked mangas, use primary)
        var primaryId = linkedMangaId ?? mangaId;

        // Notify ALL approved users about new chapters
        var userIds = await _db.Users
            .Where(u => u.IsApproved && !u.IsDisabled)
            .Select(u => u.Id)
            .ToListAsync(ct);

        if (userIds.Count == 0) return;

        foreach (var userId in userIds)
        {
            _db.Notifications.Add(new Notification
            {
                UserId = userId,
                Type = "new_chapters",
                Title = $"{mangaTitle} có chapter mới",
                Message = $"{newCount} chapter mới đã được cập nhật",
                Link = $"/manga/{primaryId}"
            });
        }
        await _db.SaveChangesAsync(ct);
    }
}
