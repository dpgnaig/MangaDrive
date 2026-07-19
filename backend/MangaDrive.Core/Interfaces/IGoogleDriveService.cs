namespace MangaDrive.Core.Interfaces;

public record DriveFile(string Id, string Name, string MimeType, DateTime? CreatedTime = null, DateTime? ModifiedTime = null);

/// <summary>
/// Represents a change detected via the Google Drive Changes API.
/// </summary>
public record DriveChange(string FileId, string? FileName, string? MimeType, bool Removed, IReadOnlyList<string>? ParentIds);

public interface IGoogleDriveService
{
    /// <summary>
    /// The service account's client email. The admin's browser needs this to grant
    /// the service account read access on folders it uploads to a personal Drive,
    /// so the existing service-account-based sync/proxy keeps working.
    /// </summary>
    string ServiceAccountEmail { get; }

    Task<List<DriveFile>> ListFoldersAsync(string parentFolderId);
    Task<List<DriveFile>> ListFilesAsync(string parentFolderId);
    Task<List<DriveFile>> ListSharedFoldersAsync();
    Task<string?> GetFileContentAsync(string fileId);
    Task<Stream> DownloadFileAsync(string fileId);

    /// <summary>
    /// Gets the start page token for the Changes API (represents "now").
    /// </summary>
    Task<string> GetStartPageTokenAsync();

    /// <summary>
    /// Gets changes since the given page token. Returns the list of changes and the new page token.
    /// </summary>
    Task<(List<DriveChange> Changes, string NewPageToken)> GetChangesAsync(string pageToken);
}
