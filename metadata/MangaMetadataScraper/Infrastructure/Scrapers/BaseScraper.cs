using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;
using Polly;
using Polly.Retry;

namespace MangaMetadataScraper.Infrastructure.Scrapers;

public abstract class BaseScraper : IMangaScraper
{
    protected readonly IBrowserFactory BrowserFactory;
    protected readonly ILogger Logger;

    private static readonly AsyncRetryPolicy RetryPolicy = Policy
        .Handle<PlaywrightException>()
        .Or<TimeoutException>()
        .WaitAndRetryAsync(
            retryCount: 2,
            sleepDurationProvider: attempt => TimeSpan.FromSeconds(attempt * 2),
            onRetry: (ex, delay, attempt, _) =>
                Console.WriteLine($"[Retry {attempt}] {ex.Message} — chờ {delay.TotalSeconds}s"));

    protected BaseScraper(IBrowserFactory browserFactory, ILogger logger)
    {
        BrowserFactory = browserFactory;
        Logger = logger;
    }

    public abstract string SourceName { get; }

    // ─── Search (trả toàn bộ list) ────────────────────────────────────────────

    public async Task<List<SearchResultItem>> SearchAsync(
        string keyword,
        CancellationToken cancellationToken = default)
    {
        Logger.LogInformation("[{Source}] Search: '{Keyword}'", SourceName, keyword);

        return await RetryPolicy.ExecuteAsync(async () =>
        {
            var (context, ownsContext) = await GetContextAsync(cancellationToken);
            var page = await context.NewPageAsync();
            try
            {
                page.SetDefaultTimeout(30_000);
                return await SearchCoreAsync(page, keyword, cancellationToken);
            }
            finally
            {
                await page.CloseAsync();
                if (ownsContext)
                    await context.DisposeAsync();
            }
        });
    }

    // ─── Get Metadata (sau khi user chọn) ─────────────────────────────────────

    public async Task<MangaMetadata?> GetMetadataAsync(
        SearchResultItem item,
        CancellationToken cancellationToken = default)
    {
        Logger.LogInformation(
            "[{Source}] Lấy metadata: '{Title}' — {Url}",
            SourceName, item.Title, item.DetailUrl);

        return await RetryPolicy.ExecuteAsync(async () =>
        {
            var (context, ownsContext) = await GetContextAsync(cancellationToken);
            var page = await context.NewPageAsync();
            try
            {
                page.SetDefaultTimeout(30_000);
                var startTime = DateTime.UtcNow;
                var result = await GetMetadataCoreAsync(page, item, cancellationToken);
                Logger.LogInformation(
                    "[{Source}] GetMetadata hoàn tất trong {Ms}ms",
                    SourceName, (DateTime.UtcNow - startTime).TotalMilliseconds);
                return result;
            }
            finally
            {
                await page.CloseAsync();
                if (ownsContext)
                    await context.DisposeAsync();
            }
        });
    }

    // ─── Overrideable context strategy ────────────────────────────────────────

    /// <summary>
    /// Mặc định: anonymous context từ shared browser.
    /// Override nếu cần persistent context (login).
    /// Trả (context, ownsContext) — ownsContext=true thì base sẽ Dispose sau khi dùng.
    /// </summary>
    protected virtual async Task<(IBrowserContext context, bool ownsContext)> GetContextAsync(
        CancellationToken cancellationToken)
    {
        var browser = await BrowserFactory.GetBrowserAsync(cancellationToken);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            ViewportSize = new ViewportSize { Width = 1280, Height = 800 }
        });
        return (context, ownsContext: true);
    }

    // ─── Abstract methods ─────────────────────────────────────────────────────

    protected abstract Task<List<SearchResultItem>> SearchCoreAsync(
        IPage page,
        string keyword,
        CancellationToken cancellationToken);

    protected abstract Task<MangaMetadata?> GetMetadataCoreAsync(
        IPage page,
        SearchResultItem item,
        CancellationToken cancellationToken);

    // ─── Image fetch helper ───────────────────────────────────────────────────

    /// <summary>
    /// Tải bytes ảnh bằng cách dùng APIRequestContext của browser context
    /// (kế thừa cookie + gửi Referer đúng) — bypass hotlink/CDN.
    /// Trả null nếu thất bại.
    /// </summary>
    protected static async Task<byte[]?> FetchImageBytesAsync(
        IPage page, string imageUrl, string? refererUrl = null)
    {
        if (string.IsNullOrWhiteSpace(imageUrl)) return null;
        try
        {
            var referer = refererUrl ?? page.Url;

            var response = await page.Context.APIRequest.FetchAsync(imageUrl,
                new APIRequestContextOptions
                {
                    Method  = "GET",
                    Headers = new Dictionary<string, string>
                    {
                        ["Referer"]        = referer,
                        ["Accept"]         = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                        ["Accept-Language"] = "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
                    }
                });

            if (!response.Ok)
            {
                Console.WriteLine($"[FetchImage] HTTP {response.Status} cho {imageUrl}");
                return null;
            }

            return await response.BodyAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FetchImage] Lỗi fetch {imageUrl}: {ex.Message}");
            return null;
        }
    }
}
