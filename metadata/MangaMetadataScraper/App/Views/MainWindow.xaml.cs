using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Navigation;
using MangaMetadataScraper.App.ViewModels;

namespace MangaMetadataScraper.App.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
    }

    private void Hyperlink_RequestNavigate(object sender, RequestNavigateEventArgs e)
    {
        Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true });
        e.Handled = true;
    }

    private void CoverScrollViewer_ScrollChanged(object sender, ScrollChangedEventArgs e)
    {
        if (sender is not ScrollViewer sv) return;
        // Scroll den gan cuoi (con lai < 150px) thi load them
        if (sv.ScrollableWidth - sv.HorizontalOffset < 150)
        {
            if (DataContext is MainViewModel vm)
                _ = vm.LoadMoreImagesAsync();
        }
    }
}
