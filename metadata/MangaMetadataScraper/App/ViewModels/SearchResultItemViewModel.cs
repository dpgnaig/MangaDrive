using MangaMetadataScraper.Core.Models;
using System.IO;
using System.Net.Http;
using System.Windows.Media.Imaging;

namespace MangaMetadataScraper.App.ViewModels;

public class SearchResultItemViewModel : ViewModelBase
{
    private static readonly HttpClient SharedHttp = new()
    {
        Timeout = TimeSpan.FromSeconds(15)
    };

    public SearchResultItem Item { get; }

    public string Title     => Item.Title;
    public string CoverUrl  => Item.CoverUrl;
    public string Source    => Item.Source;
    public string DetailUrl => Item.DetailUrl;

    public string SubTitle => !string.IsNullOrWhiteSpace(Item.Slug) ? Item.Slug : Item.DetailUrl;

    public string SourceColor => Item.Source switch
    {
        "CuuTruyen" => "#CBA6F7",
        "TruyenQQ"  => "#89DCEB",
        "AniList"   => "#02A9FF",
        _           => "#A6ADC8"
    };

    private BitmapImage? _thumbnail;
    public BitmapImage? Thumbnail
    {
        get => _thumbnail;
        private set => SetField(ref _thumbnail, value);
    }

    private bool _isLoadingThumb = true;
    public bool IsLoadingThumb
    {
        get => _isLoadingThumb;
        private set => SetField(ref _isLoadingThumb, value);
    }

    public SearchResultItemViewModel(SearchResultItem item)
    {
        Item = item;

        // Chi load thumbnail neu co CoverUrl
        if (!string.IsNullOrWhiteSpace(item.CoverUrl))
            _ = LoadThumbnailAsync(item.CoverUrl);
        else
            IsLoadingThumb = false;
    }

    private async Task LoadThumbnailAsync(string url)
    {
        try
        {
            var bytes = await SharedHttp.GetByteArrayAsync(url);
            var bmp   = new BitmapImage();
            using var ms = new MemoryStream(bytes);
            bmp.BeginInit();
            bmp.CacheOption      = BitmapCacheOption.OnLoad;
            bmp.StreamSource     = ms;
            bmp.DecodePixelWidth = 48;
            bmp.EndInit();
            bmp.Freeze();
            Thumbnail = bmp;
        }
        catch { /* giu null neu loi */ }
        finally { IsLoadingThumb = false; }
    }
}
