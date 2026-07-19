namespace MangaMetadataScraper.Core.Models;

public class AppSettings
{
    public ScraperSettings CuuTruyen  { get; set; } = new()
    {
        SourceUrl = "https://cuutruyen.net",
        Headless  = false
    };

    public ScraperSettings TruyenQQ   { get; set; } = new()
    {
        SourceUrl = "https://truyenqqko.com",
        Headless  = false
    };
}

public class ScraperSettings
{
    public string SourceUrl { get; set; } = string.Empty;
    public bool   Headless  { get; set; } = false;
}
