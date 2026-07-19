using Microsoft.Playwright;

namespace MangaMetadataScraper.Core.Interfaces;

public interface IBrowserFactory : IAsyncDisposable
{
    /// <summary>
    /// Browser thông thường — dùng cho các scraper không cần lưu session.
    /// </summary>
    Task<IBrowser> GetBrowserAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Persistent context — lưu cookies/session vào disk.
    /// Dùng cho các scraper cần login (VD: CuuTruyen).
    /// </summary>
    Task<IBrowserContext> GetPersistentContextAsync(
        string profileKey,
        CancellationToken cancellationToken = default);
}
