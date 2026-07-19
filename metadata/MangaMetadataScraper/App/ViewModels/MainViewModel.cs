using MangaMetadataScraper.App.Commands;
using MangaMetadataScraper.App.Views;
using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using Microsoft.Extensions.Logging;
using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace MangaMetadataScraper.App.ViewModels;

public class MainViewModel : ViewModelBase
{
    private readonly ISearchService        _searchService;
    private readonly IAppSettingsService   _settingsService;
    private readonly IImageSearchService   _imageSearchService;
    private readonly ILogger<MainViewModel> _logger;
    private readonly HttpClient            _httpClient;
    private readonly Dispatcher _dispatcher = Application.Current.Dispatcher;
    private CancellationTokenSource? _cts;

    // ─── Keyword ──────────────────────────────────────────────────────────────

    private string _keyword = string.Empty;
    public string Keyword
    {
        get => _keyword;
        set => SetField(ref _keyword, value);
    }

    // ─── State ────────────────────────────────────────────────────────────────

    private bool _isSearching;
    public bool IsSearching
    {
        get => _isSearching;
        set { SetField(ref _isSearching, value); OnPropertyChanged(nameof(IsIdle)); }
    }

    private bool _isLoadingDetail;
    public bool IsLoadingDetail
    {
        get => _isLoadingDetail;
        set { SetField(ref _isLoadingDetail, value); OnPropertyChanged(nameof(IsIdle)); }
    }

    private bool _isSearchingImages;
    public bool IsSearchingImages
    {
        get => _isSearchingImages;
        set => SetField(ref _isSearchingImages, value);
    }

    private bool _isLoadingMoreImages;
    public bool IsLoadingMoreImages
    {
        get => _isLoadingMoreImages;
        set => SetField(ref _isLoadingMoreImages, value);
    }

    // AniList pagination state
    private string _imageSearchTitle = string.Empty;
    private int    _aniListNextPage  = 2;
    private bool   _aniListHasMore   = false;

    private bool _isSaving;
    public bool IsSaving
    {
        get => _isSaving;
        set => SetField(ref _isSaving, value);
    }

    public bool IsIdle => !_isSearching && !_isLoadingDetail;

    private string _statusText = "Nhập tên manga và nhấn Search";
    public string StatusText
    {
        get => _statusText;
        set => SetField(ref _statusText, value);
    }

    // ─── Search Results ───────────────────────────────────────────────────────

    public ObservableCollection<SearchResultItemViewModel> SearchResults { get; } = [];

    private bool _hasSearchResults;
    public bool HasSearchResults
    {
        get => _hasSearchResults;
        set => SetField(ref _hasSearchResults, value);
    }

    private bool _noSearchResults;
    public bool NoSearchResults
    {
        get => _noSearchResults;
        set => SetField(ref _noSearchResults, value);
    }

    private SearchResultItemViewModel? _selectedItem;
    public SearchResultItemViewModel? SelectedItem
    {
        get => _selectedItem;
        set
        {
            if (SetField(ref _selectedItem, value) && value is not null)
                _ = LoadDetailAsync(value.Item);
        }
    }

    // ─── Metadata ─────────────────────────────────────────────────────────────

    private MangaMetadata? _metadata;
    public MangaMetadata? Metadata
    {
        get => _metadata;
        set
        {
            SetField(ref _metadata, value);
            OnPropertyChanged(nameof(HasMetadata));
            OnPropertyChanged(nameof(GenresDisplay));
            OnPropertyChanged(nameof(CanSave));
            OnPropertyChanged(nameof(CoverImageSource));
        }
    }

    public bool HasMetadata => _metadata is not null;
    public bool CanSave     => _metadata is not null;

    public string GenresDisplay => _metadata?.Genres is { Count: > 0 }
        ? string.Join(", ", _metadata.Genres)
        : string.Empty;

    public BitmapImage? CoverImageSource
    {
        get
        {
            if (_metadata?.CoverImageBytes is { Length: > 0 } bytes)
            {
                try
                {
                    var bmp = new BitmapImage();
                    using var ms = new MemoryStream(bytes);
                    bmp.BeginInit();
                    bmp.CacheOption  = BitmapCacheOption.OnLoad;
                    bmp.StreamSource = ms;
                    bmp.EndInit();
                    bmp.Freeze();
                    return bmp;
                }
                catch { /* fallback */ }
            }
            return null;
        }
    }

    // ─── Image Search ─────────────────────────────────────────────────────────

    public ObservableCollection<ImageResultViewModel> CoverResults  { get; } = [];
    public ObservableCollection<ImageResultViewModel> BannerResults { get; } = [];

    private ImageResultViewModel? _selectedCover;
    public ImageResultViewModel? SelectedCover
    {
        get => _selectedCover;
        set
        {
            if (_selectedCover is not null) _selectedCover.IsSelected = false;
            SetField(ref _selectedCover, value);
            if (value is not null)
            {
                value.IsSelected = true;
                if (_metadata is not null) _metadata.ExternalCoverUrl = value.Item.Url;
            }
        }
    }

    private ImageResultViewModel? _selectedBanner;
    public ImageResultViewModel? SelectedBanner
    {
        get => _selectedBanner;
        set
        {
            if (_selectedBanner is not null) _selectedBanner.IsSelected = false;
            SetField(ref _selectedBanner, value);
            if (value is not null)
            {
                value.IsSelected = true;
                if (_metadata is not null) _metadata.ExternalBannerUrl = value.Item.Url;
            }
        }
    }

    // ─── Commands ─────────────────────────────────────────────────────────────

    public ICommand SearchCommand         { get; }
    public ICommand CancelCommand         { get; }
    public ICommand SaveMetadataCommand   { get; }
    public ICommand OpenSettingsCommand   { get; }
    public ICommand SearchImagesCommand   { get; }
    public ICommand LoadMoreImagesCommand { get; }

    // ─── Constructor ─────────────────────────────────────────────────────────

    public MainViewModel(
        ISearchService searchService,
        IAppSettingsService settingsService,
        IImageSearchService imageSearchService,
        ILogger<MainViewModel> logger)
    {
        _searchService      = searchService;
        _settingsService    = settingsService;
        _imageSearchService = imageSearchService;
        _logger             = logger;
        _httpClient         = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "MangaMetadataScraper/1.0");

        SearchCommand = new AsyncRelayCommand(
            ExecuteSearchAsync,
            _ => IsIdle && !string.IsNullOrWhiteSpace(Keyword));

        CancelCommand = new RelayCommand(
            _ => _cts?.Cancel(),
            _ => !IsIdle);

        SaveMetadataCommand = new AsyncRelayCommand(
            _ => ExecuteSaveMetadataAsync(),
            _ => CanSave && !_isSaving);

        OpenSettingsCommand = new RelayCommand(_ => OpenSettings());

        SearchImagesCommand = new AsyncRelayCommand(
            _ => ExecuteSearchImagesAsync(),
            _ => HasMetadata && !IsSearchingImages);

        LoadMoreImagesCommand = new AsyncRelayCommand(
            _ => LoadMoreImagesAsync(),
            _ => _aniListHasMore && !IsLoadingMoreImages && !IsSearchingImages);
    }

    // ─── Phase 1: Search ─────────────────────────────────────────────────────

    private async Task ExecuteSearchAsync(object? _)
    {
        if (string.IsNullOrWhiteSpace(Keyword)) return;

        _cts?.Cancel();
        _cts?.Dispose();
        _cts = new CancellationTokenSource();

        IsSearching = true;
        Metadata    = null;
        SelectedItem = null;
        SearchResults.Clear();
        CoverResults.Clear();
        BannerResults.Clear();
        SelectedCover  = null;
        SelectedBanner = null;
        HasSearchResults = false;
        NoSearchResults  = false;
        StatusText = $"Đang tìm kiếm '{Keyword}' trên tất cả site...";

        try
        {
            var items = await _searchService.SearchAllAsync(Keyword.Trim(), _cts.Token);

            foreach (var item in items)
                SearchResults.Add(new SearchResultItemViewModel(item));

            HasSearchResults = SearchResults.Count > 0;
            NoSearchResults  = SearchResults.Count == 0;
            StatusText = HasSearchResults
                ? $"Tìm thấy {SearchResults.Count} kết quả — chọn 1 để xem metadata"
                : "Không tìm thấy kết quả nào.";
        }
        catch (OperationCanceledException) { StatusText = "Đã huỷ tìm kiếm."; }
        catch (Exception ex)
        {
            StatusText = $"Lỗi: {ex.Message}";
            _logger.LogError(ex, "Lỗi trong ExecuteSearchAsync");
        }
        finally { IsSearching = false; }
    }

    // ─── Phase 2: Load detail ─────────────────────────────────────────────────

    private async Task LoadDetailAsync(SearchResultItem item)
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = new CancellationTokenSource();

        _dispatcher.Invoke(() =>
        {
            IsLoadingDetail = true;
            Metadata        = null;
            CoverResults.Clear();
            BannerResults.Clear();
            SelectedCover  = null;
            SelectedBanner = null;
            StatusText     = $"Đang tải metadata: '{item.Title}' [{item.Source}]...";
        });

        try
        {
            var metadata = await _searchService.GetMetadataAsync(item, _cts.Token);

            _dispatcher.Invoke(() =>
            {
                if (metadata is not null)
                {
                    Metadata   = metadata;
                    StatusText = $"Tim anh cho '{metadata.Title}'...";
                    // Tu dong search anh ngay sau khi co metadata
                    _ = ExecuteSearchImagesAsync();
                }
                else
                {
                    StatusText = "Khong lay duoc metadata.";
                }
            });
        }
        catch (OperationCanceledException)
        {
            _dispatcher.Invoke(() => StatusText = "Đã huỷ.");
        }
        catch (Exception ex)
        {
            _dispatcher.Invoke(() => StatusText = $"Lỗi: {ex.Message}");
            _logger.LogError(ex, "Lỗi trong LoadDetailAsync");
        }
        finally
        {
            _dispatcher.Invoke(() => IsLoadingDetail = false);
        }
    }

    // --- Phase 3: Search Images (MangaDex + AniList) --------------------------

    private async Task ExecuteSearchImagesAsync()
    {
        if (_metadata is null) return;

        IsSearchingImages = true;
        CoverResults.Clear();
        BannerResults.Clear();
        SelectedCover  = null;
        SelectedBanner = null;
        _aniListHasMore  = false;
        _aniListNextPage = 2;

        var queryTitles = new List<string> { Keyword.Trim() };

        StatusText = $"Tim anh cho '{Keyword}'...";

        try
        {
            var token = _cts?.Token ?? CancellationToken.None;

            _logger.LogInformation("[ImageSearch] Query: '{Title}'", Keyword);
            var (allResults, hasNext) = await _imageSearchService.SearchImagesAsync(Keyword.Trim(), token);
            _imageSearchTitle = Keyword.Trim();
            _aniListHasMore   = hasNext;
            _aniListNextPage  = 2;

            AppendImageResults(allResults);

            var coverCount  = CoverResults.Count;
            var bannerCount = BannerResults.Count;
            StatusText = (coverCount + bannerCount) > 0
                ? $"{coverCount} cover, {bannerCount} banner{(hasNext ? " — scroll de load them" : string.Empty)}"
                : "Khong tim duoc anh nao.";
        }
        catch (Exception ex)
        {
            StatusText = $"Loi tim anh: {ex.Message}";
            _logger.LogError(ex, "Loi trong ExecuteSearchImagesAsync");
        }
        finally
        {
            IsSearchingImages = false;
        }
    }

    public async Task LoadMoreImagesAsync()
    {
        if (!_aniListHasMore || IsLoadingMoreImages || string.IsNullOrEmpty(_imageSearchTitle)) return;

        IsLoadingMoreImages = true;
        try
        {
            var token = _cts?.Token ?? CancellationToken.None;
            var (results, hasNext) = await _imageSearchService.LoadMoreAniListAsync(
                _imageSearchTitle, _aniListNextPage, token);

            _aniListHasMore = hasNext;
            _aniListNextPage++;

            AppendImageResults(results);

            _logger.LogInformation("[ImageSearch] Load them page {Page}: {Count} item(s)",
                _aniListNextPage - 1, results.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Loi LoadMoreImagesAsync");
        }
        finally
        {
            IsLoadingMoreImages = false;
        }
    }

    private void AppendImageResults(List<ImageSearchResult> results)
    {
        foreach (var r in results)
        {
            var vm = new ImageResultViewModel(r);
            _ = vm.LoadThumbnailAsync(_httpClient);

            if (r.Type == "banner")
                BannerResults.Add(vm);
            else
                CoverResults.Add(vm);
        }
    }

    // ─── Save Metadata → JSON + cover.jpg + banner.jpg ────────────────────────

    private async Task ExecuteSaveMetadataAsync()
    {
        if (_metadata is null) return;

        try
        {
            // ── Chọn thư mục lưu ─────────────────────────────────────────
            var dlg = new Microsoft.Win32.SaveFileDialog
            {
                Title      = "Lưu Metadata",
                Filter     = "JSON files (*.json)|*.json",
                FileName   = "metadata.json",
                DefaultExt = ".json"
            };

            if (dlg.ShowDialog() != true) return;

            IsSaving  = true;
            var saveDir = Path.GetDirectoryName(dlg.FileName)!;
            StatusText  = "Đang tải và lưu ảnh...";

            // ── Download cover ────────────────────────────────────────────
            var coverFileName  = string.Empty;
            var bannerFileName = string.Empty;

            var coverUrl  = !string.IsNullOrWhiteSpace(_metadata.ExternalCoverUrl)
                ? _metadata.ExternalCoverUrl
                : _metadata.CoverUrl;

            var bannerUrl = _metadata.ExternalBannerUrl;

            if (!string.IsNullOrWhiteSpace(coverUrl))
            {
                var ext  = GuessImageExtension(coverUrl);
                var path = Path.Combine(saveDir, $"cover{ext}");
                var ok   = await DownloadFileAsync(coverUrl, path);
                if (ok) coverFileName = Path.GetFileName(path);
            }
            // Fallback: dùng CoverImageBytes (ảnh đã tải qua browser)
            else if (_metadata.CoverImageBytes is { Length: > 0 } imgBytes)
            {
                var path = Path.Combine(saveDir, "cover.jpg");
                await File.WriteAllBytesAsync(path, imgBytes);
                coverFileName = "cover.jpg";
            }

            if (!string.IsNullOrWhiteSpace(bannerUrl))
            {
                var ext  = GuessImageExtension(bannerUrl);
                var path = Path.Combine(saveDir, $"banner{ext}");
                var ok   = await DownloadFileAsync(bannerUrl, path);
                if (ok) bannerFileName = Path.GetFileName(path);
            }

            // ── Serialize JSON theo format metadata.example.json ────────────
            StatusText = "Đang ghi metadata.json...";

            // OtherTitles: dùng structured OtherTitles (lang + title) nếu có,
            // fallback sang AlternativeTitle nếu cần
            var otherTitles = _metadata.OtherTitles is { Count: > 0 }
                ? _metadata.OtherTitles
                    .Select(t => new { lang = t.Lang, title = t.Title })
                    .ToList<object>()
                : !string.IsNullOrWhiteSpace(_metadata.AlternativeTitle)
                    ? _metadata.AlternativeTitle
                        .Split('/', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                        .Select(t => (object)new { lang = "", title = t })
                        .ToList()
                    : new List<object>();

            var export = new
            {
                title       = _metadata.Title,
                otherTitles,
                description = _metadata.Description,
                author      = _metadata.Author,
                artist      = !string.IsNullOrWhiteSpace(_metadata.Artist) ? _metadata.Artist : null,
                status      = NormalizeStatus(_metadata.Status),
                genres      = _metadata.Genres,
                themes      = _metadata.Themes is { Count: > 0 } ? _metadata.Themes : null,
                demographic = !string.IsNullOrWhiteSpace(_metadata.Demographic) ? _metadata.Demographic : null,
                cover       = string.IsNullOrEmpty(coverFileName)  ? null : coverFileName,
                banner      = string.IsNullOrEmpty(bannerFileName) ? null : bannerFileName
            };

            var options = new JsonSerializerOptions
            {
                WriteIndented          = true,
                Encoder                = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
            };

            var json = JsonSerializer.Serialize(export, options);
            await File.WriteAllTextAsync(dlg.FileName, json, System.Text.Encoding.UTF8);

            var saved = new List<string> { Path.GetFileName(dlg.FileName) };
            if (!string.IsNullOrEmpty(coverFileName))  saved.Add(coverFileName);
            if (!string.IsNullOrEmpty(bannerFileName)) saved.Add(bannerFileName);

            StatusText = $"✓ Đã lưu: {string.Join(", ", saved)}";
            _logger.LogInformation("Saved to {Dir}: {Files}", saveDir, string.Join(", ", saved));
        }
        catch (Exception ex)
        {
            StatusText = $"Lỗi khi lưu: {ex.Message}";
            _logger.LogError(ex, "Lỗi trong ExecuteSaveMetadataAsync");
        }
        finally
        {
            IsSaving = false;
        }
    }

    private async Task<bool> DownloadFileAsync(string url, string destPath)
    {
        try
        {
            var bytes = await _httpClient.GetByteArrayAsync(url);
            await File.WriteAllBytesAsync(destPath, bytes);
            _logger.LogInformation("Downloaded {Url} → {Path}", url, destPath);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Không tải được ảnh: {Url}", url);
            return false;
        }
    }

    private static string GuessImageExtension(string url)
    {
        var path = url.Split('?')[0]; // bỏ query string
        var ext  = Path.GetExtension(path).ToLowerInvariant();
        return ext is ".jpg" or ".jpeg" or ".png" or ".webp" or ".gif" ? ext : ".jpg";
    }

    private static string NormalizeStatus(string status)
    {
        if (string.IsNullOrWhiteSpace(status)) return string.Empty;
        return status.ToLowerInvariant() switch
        {
            "ongoing"   or "đang tiến hành" or "đang ra"     => "ongoing",
            "completed" or "hoàn thành"    or "hoàn thành"  => "completed",
            "hiatus"    or "tạm dừng"                       => "hiatus",
            "cancelled" or "đã hủy"                         => "cancelled",
            _                                                => status.ToLowerInvariant()
        };
    }

    // ─── Settings ─────────────────────────────────────────────────────────────

    private void OpenSettings()
    {
        var vm  = new SettingsViewModel(_settingsService);
        var win = new SettingsWindow(vm) { Owner = Application.Current.MainWindow };
        win.ShowDialog();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static string SanitizeFileName(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars())
            name = name.Replace(c, '_');
        return name.Trim();
    }
}
