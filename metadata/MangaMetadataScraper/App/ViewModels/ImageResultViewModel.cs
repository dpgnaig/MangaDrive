using MangaMetadataScraper.Core.Models;
using System.IO;
using System.Net.Http;
using System.Windows.Media.Imaging;

namespace MangaMetadataScraper.App.ViewModels;

public class ImageResultViewModel : ViewModelBase
{
    public ImageSearchResult Item { get; }

    public string Label  => Item.Label;
    public string Source => Item.Source;
    public string Type   => Item.Type;
    public string Url    => Item.Url;

    public string SourceColor => Item.Source switch
    {
        "MangaDex" => "#F4A261",
        "AniList"  => "#02A9FF",
        _          => "#585B70"
    };

    private bool _isSelected;
    public bool IsSelected
    {
        get => _isSelected;
        set => SetField(ref _isSelected, value);
    }

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

    public ImageResultViewModel(ImageSearchResult item)
    {
        Item = item;
    }

    public async Task LoadThumbnailAsync(HttpClient http)
    {
        var url = string.IsNullOrWhiteSpace(Item.ThumbUrl) ? Item.Url : Item.ThumbUrl;
        if (string.IsNullOrWhiteSpace(url)) { IsLoadingThumb = false; return; }

        try
        {
            var bytes = await http.GetByteArrayAsync(url);
            var bmp   = new BitmapImage();
            using var ms = new MemoryStream(bytes);
            bmp.BeginInit();
            bmp.CacheOption  = BitmapCacheOption.OnLoad;
            bmp.StreamSource = ms;
            bmp.DecodePixelWidth = 160; // giới hạn kích thước decode
            bmp.EndInit();
            bmp.Freeze();
            Thumbnail = bmp;
        }
        catch { /* giữ null nếu lỗi */ }
        finally { IsLoadingThumb = false; }
    }
}
