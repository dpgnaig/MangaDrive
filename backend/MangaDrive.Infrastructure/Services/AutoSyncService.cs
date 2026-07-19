using MangaDrive.Core.Entities;
using MangaDrive.Core.Interfaces;
using MangaDrive.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace MangaDrive.Infrastructure.Services;

/// <summary>
/// Periodically polls Google Drive Changes API to detect updates.
/// Uses a single global page token (service account scope) and maps changes
/// to the correct root folder / manga. Only queues sync for affected mangas.
/// </summary>
public class AutoSyncService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);

    /// <summary>
    /// Global changes page token stored in-memory.
    /// On first run, initialized from DB (first root folder's token) or from Drive API.
    /// </summary>
    private string? _globalPageToken;

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<AutoSyncService> _logger;

    public AutoSyncService(IServiceScopeFactory scopeFactory, ILogger<AutoSyncService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait a bit after startup before first check
        await Task.Delay(TimeSpan.FromMinutes(2), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ScanAndSyncIfNeeded(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Auto sync scan failed");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }

    private async Task ScanAndSyncIfNeeded(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var drive = scope.ServiceProvider.GetRequiredService<IGoogleDriveService>();

        int totalQueued = 0;

        // === Step 1: Detect new shared root folders ===
        totalQueued += await DetectNewSharedFolders(db, drive, ct);

        // === Step 2: Get all active root folders ===
        var rootFolders = await db.RootFolders
            .Where(rf => rf.IsActive)
            .ToListAsync(ct);

        if (rootFolders.Count == 0 && totalQueued == 0) return;

        // === Step 3: Initialize global token if needed ===
        if (_globalPageToken == null)
        {
            // Try to load from any root that already has a token
            var existingToken = rootFolders
                .Where(rf => !string.IsNullOrEmpty(rf.ChangesPageToken))
                .Select(rf => rf.ChangesPageToken)
                .FirstOrDefault();

            if (existingToken != null)
            {
                _globalPageToken = existingToken;
            }
            else
            {
                // First time ever: get current token and queue full sync for all roots
                _globalPageToken = await drive.GetStartPageTokenAsync();

                foreach (var root in rootFolders)
                {
                    root.ChangesPageToken = _globalPageToken;
                    root.LastSyncedAt = DateTime.UtcNow;
                }
                await db.SaveChangesAsync(ct);

                _logger.LogInformation("Auto sync: first run, initialized global token, queueing full sync for {Count} root(s)", rootFolders.Count);
                foreach (var root in rootFolders)
                {
                    await SyncBackgroundService.Queue.Writer.WriteAsync(
                        new SyncRequest(root.Id, SyncRequestType.RootFolder), ct);
                    totalQueued++;
                }

                if (totalQueued > 0)
                    _logger.LogInformation("Auto sync: queued {Count} sync requests", totalQueued);
                return;
            }
        }

        // === Step 4: Poll Changes API once (global scope) ===
        var (changes, newToken) = await drive.GetChangesAsync(_globalPageToken);
        _globalPageToken = newToken;

        if (changes.Count == 0)
        {
            _logger.LogInformation("Auto sync: no changes detected");
            // Update all root tokens to stay in sync
            foreach (var root in rootFolders)
                root.ChangesPageToken = newToken;
            await db.SaveChangesAsync(ct);
            return;
        }

        _logger.LogInformation("Auto sync: {Count} change(s) detected from Drive", changes.Count);

        // === Step 5: Build lookup maps ===
        // Root folder DriveId → RootFolder entity
        var rootByDriveId = rootFolders.ToDictionary(rf => rf.GoogleDriveFolderId, rf => rf);

        // All mangas across all roots
        var allMangas = await db.Mangas
            .Where(m => rootFolders.Select(rf => rf.Id).Contains(m.RootFolderId))
            .Select(m => new { m.Id, m.DriveFileId, m.RootFolderId })
            .ToListAsync(ct);

        var mangaByDriveId = allMangas.ToDictionary(m => m.DriveFileId, m => m);

        // All chapters → manga mapping
        var allMangaIds = allMangas.Select(m => m.Id).ToList();
        var chapters = await db.Chapters
            .Where(c => allMangaIds.Contains(c.MangaId))
            .Select(c => new { c.DriveFileId, c.MangaId })
            .ToListAsync(ct);
        var chapterToMangaId = chapters.ToDictionary(c => c.DriveFileId, c => c.MangaId);

        // === Step 6: Map each change to affected manga(s) ===
        var mangasToSync = new HashSet<Guid>();
        var rootsNeedFullSync = new HashSet<Guid>();

        foreach (var change in changes)
        {
            // Case 1: Changed file IS a manga folder
            if (mangaByDriveId.TryGetValue(change.FileId, out var manga))
            {
                mangasToSync.Add(manga.Id);
                continue;
            }

            // Case 2: Changed file IS a chapter folder
            if (chapterToMangaId.TryGetValue(change.FileId, out var chapterMangaId))
            {
                mangasToSync.Add(chapterMangaId);
                continue;
            }

            // Case 3: Changed file's parent is a known entity
            if (change.ParentIds != null)
            {
                bool mapped = false;
                foreach (var parentId in change.ParentIds)
                {
                    // Parent is a manga folder → file added/removed in manga (e.g., new chapter folder)
                    if (mangaByDriveId.TryGetValue(parentId, out var parentManga))
                    {
                        mangasToSync.Add(parentManga.Id);
                        mapped = true;
                        break;
                    }

                    // Parent is a chapter folder → image added/removed
                    if (chapterToMangaId.TryGetValue(parentId, out var parentChapterMangaId))
                    {
                        mangasToSync.Add(parentChapterMangaId);
                        mapped = true;
                        break;
                    }

                    // Parent is a root folder → new manga folder added
                    if (rootByDriveId.TryGetValue(parentId, out var rootFolder))
                    {
                        rootsNeedFullSync.Add(rootFolder.Id);
                        mapped = true;
                        break;
                    }
                }

                // If we couldn't map, it might be deeply nested or unrelated — ignore
                if (!mapped) continue;
            }
        }

        // === Step 7: Queue syncs ===
        // Full root syncs (new manga added to a root)
        foreach (var rootId in rootsNeedFullSync)
        {
            var root = rootFolders.First(rf => rf.Id == rootId);
            _logger.LogInformation("Auto sync: new content in root '{Name}', queueing full root sync", root.Name);
            await SyncBackgroundService.Queue.Writer.WriteAsync(
                new SyncRequest(rootId, SyncRequestType.RootFolder), ct);
            totalQueued++;
        }

        // Individual manga syncs (exclude mangas in roots that already get full sync)
        var individualMangas = mangasToSync
            .Where(mangaId => !rootsNeedFullSync.Contains(
                allMangas.First(m => m.Id == mangaId).RootFolderId))
            .ToList();

        if (individualMangas.Count > 0)
        {
            _logger.LogInformation("Auto sync: {Count} manga(s) have changes, queueing individual syncs", individualMangas.Count);
            foreach (var mangaId in individualMangas)
            {
                await SyncBackgroundService.Queue.Writer.WriteAsync(
                    new SyncRequest(mangaId, SyncRequestType.Manga), ct);
                totalQueued++;
            }
        }

        // === Step 8: Update all root tokens ===
        foreach (var root in rootFolders)
        {
            root.ChangesPageToken = newToken;
            if (rootsNeedFullSync.Contains(root.Id) || individualMangas.Any(id =>
                allMangas.Any(m => m.Id == id && m.RootFolderId == root.Id)))
            {
                root.LastSyncedAt = DateTime.UtcNow;
            }
        }
        await db.SaveChangesAsync(ct);

        if (totalQueued > 0)
            _logger.LogInformation("Auto sync: queued {Count} sync requests total", totalQueued);
        else
            _logger.LogInformation("Auto sync: changes detected but none relevant to tracked mangas");
    }

    /// <summary>
    /// Detects new shared folders on Drive that are not yet registered as root folders.
    /// </summary>
    private async Task<int> DetectNewSharedFolders(AppDbContext db, IGoogleDriveService drive, CancellationToken ct)
    {
        int queued = 0;
        try
        {
            var sharedFolders = await drive.ListSharedFoldersAsync();
            _logger.LogInformation(
                "Auto sync: Drive returned {Count} shared folder(s): {Names}",
                sharedFolders.Count,
                string.Join(", ", sharedFolders.Select(f => $"{f.Name} ({f.Id})")));

            var existingRootDriveIds = await db.RootFolders
                .Select(rf => rf.GoogleDriveFolderId)
                .ToListAsync(ct);
            var existingSet = existingRootDriveIds.ToHashSet();

            foreach (var shared in sharedFolders)
            {
                if (existingSet.Contains(shared.Id)) continue;

                var newRoot = new MangaRootFolder
                {
                    Name = shared.Name,
                    GoogleDriveFolderId = shared.Id,
                    IsPublic = true,
                    IsActive = true,
                    IsAutoAdded = true
                };
                db.RootFolders.Add(newRoot);
                await db.SaveChangesAsync(ct);

                _logger.LogInformation("Auto sync: new shared folder '{Name}' detected, added and queueing sync", shared.Name);
                await SyncBackgroundService.Queue.Writer.WriteAsync(
                    new SyncRequest(newRoot.Id, SyncRequestType.RootFolder), ct);
                queued++;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Auto sync: failed to scan shared folders");
        }
        return queued;
    }
}
