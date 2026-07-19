namespace MangaDrive.Core.Entities;

public class ChapterImage
{
    public Guid Id { get; set; }
    public Guid ChapterId { get; set; }
    public string DriveFileId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string MimeType { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    public Chapter Chapter { get; set; } = null!;
}
