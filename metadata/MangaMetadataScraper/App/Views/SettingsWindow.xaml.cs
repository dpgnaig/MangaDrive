using MangaMetadataScraper.App.ViewModels;
using System.Windows;

namespace MangaMetadataScraper.App.Views;

public partial class SettingsWindow : Window
{
    public SettingsWindow(SettingsViewModel vm)
    {
        InitializeComponent();
        DataContext = vm;
        vm.CloseRequested += () => Close();
    }
}
