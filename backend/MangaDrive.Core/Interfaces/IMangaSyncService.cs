namespace MangaDrive.Core.Interfaces;

public interface IMangaSyncService
{
    Task SyncRootFolderAsync(Guid rootFolderId, CancellationToken ct = default);
    Task SyncSingleMangaAsync(Guid mangaId, CancellationToken ct = default);
}
