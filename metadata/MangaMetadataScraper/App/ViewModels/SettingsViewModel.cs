using MangaMetadataScraper.App.Commands;
using MangaMetadataScraper.Core.Interfaces;
using System.Windows.Input;

namespace MangaMetadataScraper.App.ViewModels;

public class SettingsViewModel : ViewModelBase
{
    private readonly IAppSettingsService _settingsService;

    // ── CuuTruyen ─────────────────────────────────────────────────────────────

    private string _cuuTruyenUrl;
    public string CuuTruyenUrl
    {
        get => _cuuTruyenUrl;
        set => SetField(ref _cuuTruyenUrl, value);
    }

    private bool _cuuTruyenHeadless;
    public bool CuuTruyenHeadless
    {
        get => _cuuTruyenHeadless;
        set => SetField(ref _cuuTruyenHeadless, value);
    }

    // ── TruyenQQ ──────────────────────────────────────────────────────────────

    private string _truyenQQUrl;
    public string TruyenQQUrl
    {
        get => _truyenQQUrl;
        set => SetField(ref _truyenQQUrl, value);
    }

    private bool _truyenQQHeadless;
    public bool TruyenQQHeadless
    {
        get => _truyenQQHeadless;
        set => SetField(ref _truyenQQHeadless, value);
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    public ICommand SaveCommand   { get; }
    public ICommand CancelCommand { get; }

    public event Action? CloseRequested;

    public SettingsViewModel(IAppSettingsService settingsService)
    {
        _settingsService = settingsService;

        // Load current values
        _cuuTruyenUrl      = _settingsService.Current.CuuTruyen.SourceUrl;
        _cuuTruyenHeadless = _settingsService.Current.CuuTruyen.Headless;
        _truyenQQUrl       = _settingsService.Current.TruyenQQ.SourceUrl;
        _truyenQQHeadless  = _settingsService.Current.TruyenQQ.Headless;

        SaveCommand = new RelayCommand(_ =>
        {
            _settingsService.Current.CuuTruyen.SourceUrl = CuuTruyenUrl;
            _settingsService.Current.CuuTruyen.Headless  = CuuTruyenHeadless;
            _settingsService.Current.TruyenQQ.SourceUrl  = TruyenQQUrl;
            _settingsService.Current.TruyenQQ.Headless   = TruyenQQHeadless;
            _settingsService.Save();
            CloseRequested?.Invoke();
        });

        CancelCommand = new RelayCommand(_ => CloseRequested?.Invoke());
    }
}
