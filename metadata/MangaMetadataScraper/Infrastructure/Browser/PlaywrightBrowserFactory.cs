using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;
using System.IO;

namespace MangaMetadataScraper.Infrastructure.Browser;

public sealed class PlaywrightBrowserFactory : IBrowserFactory
{
    private readonly ILogger<PlaywrightBrowserFactory> _logger;
    private readonly IAppSettingsService _settings;
    private readonly SemaphoreSlim _lock         = new(1, 1);
    private readonly SemaphoreSlim _persistentLock = new(1, 1);

    private IPlaywright? _playwright;
    private IBrowser?    _browser;
    private readonly Dictionary<string, IBrowserContext> _persistentContexts = [];
    private bool _disposed;

    private static readonly string UserDataRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MangaMetadataScraper", "Profiles");

    public PlaywrightBrowserFactory(
        ILogger<PlaywrightBrowserFactory> logger,
        IAppSettingsService settings)
    {
        _logger   = logger;
        _settings = settings;
        Directory.CreateDirectory(UserDataRoot);
    }

    // ─── Anonymous browser (TruyenQQ) ────────────────────────────────────────

    public async Task<IBrowser> GetBrowserAsync(CancellationToken cancellationToken = default)
    {
        if (_browser is not null && _browser.IsConnected) return _browser;

        await _lock.WaitAsync(cancellationToken);
        try
        {
            if (_browser is not null && _browser.IsConnected) return _browser;

            await EnsurePlaywrightAsync();
            _logger.LogInformation("Khởi động Chromium browser (TruyenQQ)...");

            _browser = await _playwright!.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = _settings.Current.TruyenQQ.Headless,
                Args     = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
            });

            _logger.LogInformation("Chromium browser đã khởi động.");
            return _browser;
        }
        finally { _lock.Release(); }
    }

    // ─── Persistent context (CuuTruyen — lưu session) ────────────────────────

    public async Task<IBrowserContext> GetPersistentContextAsync(
        string profileKey,
        CancellationToken cancellationToken = default)
    {
        if (_persistentContexts.TryGetValue(profileKey, out var existing)) return existing;

        await _persistentLock.WaitAsync(cancellationToken);
        try
        {
            if (_persistentContexts.TryGetValue(profileKey, out existing)) return existing;

            await EnsurePlaywrightAsync();

            var headless = profileKey == "cuutruyen"
                ? _settings.Current.CuuTruyen.Headless
                : false;

            var userDataDir = Path.Combine(UserDataRoot, profileKey);
            Directory.CreateDirectory(userDataDir);

            _logger.LogInformation(
                "Tạo persistent context '{Profile}' headless={Headless}", profileKey, headless);

            var context = await _playwright!.Chromium.LaunchPersistentContextAsync(
                userDataDir,
                new BrowserTypeLaunchPersistentContextOptions
                {
                    Headless    = headless,
                    ViewportSize = new ViewportSize { Width = 1280, Height = 800 },
                    UserAgent   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    Args        = ["--no-sandbox", "--disable-setuid-sandbox"]
                });

            _persistentContexts[profileKey] = context;
            _logger.LogInformation("Persistent context '{Profile}' đã sẵn sàng.", profileKey);
            return context;
        }
        finally { _persistentLock.Release(); }
    }

    private async Task EnsurePlaywrightAsync()
    {
        if (_playwright is not null) return;
        _playwright = await Playwright.CreateAsync();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        foreach (var ctx in _persistentContexts.Values)
            try { await ctx.CloseAsync(); } catch { }
        _persistentContexts.Clear();

        if (_browser is not null)
        {
            try { await _browser.CloseAsync(); } catch { }
            _browser = null;
        }

        _playwright?.Dispose();
        _playwright = null;
        _lock.Dispose();
        _persistentLock.Dispose();
    }
}
