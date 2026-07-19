using MangaMetadataScraper.Core.Interfaces;
using MangaMetadataScraper.Core.Models;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MangaMetadataScraper.Infrastructure;

public class AppSettingsService : IAppSettingsService
{
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MangaMetadataScraper", "settings.json");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented        = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never
    };

    public AppSettings Current { get; private set; } = new();

    public AppSettingsService() => Load();

    public void Load()
    {
        try
        {
            if (!File.Exists(SettingsPath))
            {
                Current = new AppSettings();
                Save(); // tạo file mặc định
                return;
            }

            var json = File.ReadAllText(SettingsPath);
            Current = JsonSerializer.Deserialize<AppSettings>(json, JsonOptions) ?? new AppSettings();
        }
        catch
        {
            Current = new AppSettings();
        }
    }

    public void Save()
    {
        var dir = Path.GetDirectoryName(SettingsPath)!;
        Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(Current, JsonOptions);
        File.WriteAllText(SettingsPath, json);
    }
}
