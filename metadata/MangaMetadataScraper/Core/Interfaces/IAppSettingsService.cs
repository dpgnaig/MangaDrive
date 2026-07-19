using MangaMetadataScraper.Core.Models;

namespace MangaMetadataScraper.Core.Interfaces;

public interface IAppSettingsService
{
    AppSettings Current { get; }
    void Save();
    void Load();
}
