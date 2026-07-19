using MangaMetadataScraper.App.ViewModels;
using MangaMetadataScraper.Infrastructure.Logging;
using MangaMetadataScraper.App.Views;
using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Services;
using MangaMetadataScraper.Infrastructure;
using MangaMetadataScraper.Infrastructure.Browser;
using MangaMetadataScraper.Infrastructure.ImageSearch;
using MangaMetadataScraper.Infrastructure.Scrapers.AniList;
using MangaMetadataScraper.Infrastructure.Scrapers.CuuTruyen;
using MangaMetadataScraper.Infrastructure.Scrapers.TruyenQQ;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;
using System.Windows;

namespace MangaMetadataScraper.App;

public partial class App : Application
{
    private IServiceProvider? _serviceProvider;
    private IBrowserFactory? _browserFactory;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Cài Playwright browsers nếu chưa có
        await EnsurePlaywrightAsync();

        var services = new ServiceCollection();
        ConfigureServices(services);

        _serviceProvider = services.BuildServiceProvider();
        _browserFactory = _serviceProvider.GetRequiredService<IBrowserFactory>();

        var mainWindow = _serviceProvider.GetRequiredService<MainWindow>();
        mainWindow.Show();
    }

    private static void ConfigureServices(IServiceCollection services)
    {
        // Logging
        services.AddLogging(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Debug);
            builder.AddConsole();
            builder.AddDebug();
            builder.AddFileLogger(); // Ghi log ra file AppData
        });

        // Settings (singleton — load ngay khi khởi động)
        services.AddSingleton<IAppSettingsService, AppSettingsService>();

        // Browser (singleton — chỉ 1 browser)
        services.AddSingleton<IBrowserFactory, PlaywrightBrowserFactory>();

        // Scrapers -- thu tu = thu tu fallback
        services.AddTransient<IMangaScraper, CuuTruyenScraper>();
        services.AddTransient<IMangaScraper, TruyenQQScraper>();
        services.AddTransient<IMangaScraper, AniListScraper>();

        // Image search services (singleton — dùng chung HttpClient)
        services.AddSingleton<MangaDexImageService>();
        services.AddSingleton<AniListImageService>();
        services.AddSingleton<IImageSearchService, CombinedImageSearchService>();

        // Search service
        services.AddTransient<ISearchService, SearchService>();

        // MVVM
        services.AddTransient<MainViewModel>();
        services.AddTransient<SettingsViewModel>();
        services.AddTransient<MainWindow>(sp =>
        {
            var vm = sp.GetRequiredService<MainViewModel>();
            var window = new MainWindow { DataContext = vm };
            return window;
        });
    }

    private static async Task EnsurePlaywrightAsync()
    {
        try
        {
            var exitCode = Microsoft.Playwright.Program.Main(["install", "chromium"]);
            if (exitCode != 0)
                throw new InvalidOperationException("Playwright install chromium thất bại.");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Không thể cài đặt Playwright browsers:\n{ex.Message}",
                "Lỗi khởi động",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }

        await Task.CompletedTask;
    }

    protected override async void OnExit(ExitEventArgs e)
    {
        if (_browserFactory is IAsyncDisposable asyncDisposable)
            await asyncDisposable.DisposeAsync();

        if (_serviceProvider is IDisposable disposable)
            disposable.Dispose();

        base.OnExit(e);
    }
}
