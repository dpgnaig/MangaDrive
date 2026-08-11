using MangaDrive.Core.Entities;

namespace MangaDrive.Core.DTOs;

/// <summary>
/// Standard paginated response envelope shared by every list endpoint.
/// Serializes to { items, total, page, pageSize, hasMore } (camelCase).
/// </summary>
public record PaginatedResult<T>(IReadOnlyList<T> Items, int Total, int Page, int PageSize, bool HasMore)
{
    /// <summary>Build a result, deriving HasMore from the current page window.</summary>
    public static PaginatedResult<T> Create(IReadOnlyList<T> items, int total, int page, int pageSize)
        => new(items, total, page, pageSize, page * pageSize < total);
}

/// <summary>
/// Page/pageSize query parameters with clamping shared by list endpoints.
/// Bind with [FromQuery]; call Normalized() to get sane, bounded values.
/// </summary>
public record PaginationQuery(int Page = 1, int PageSize = 20)
{
    public const int MaxPageSize = 100;
    public const int DefaultPageSize = 20;

    /// <summary>Clamp page to >= 1 and pageSize to (0, MaxPageSize], falling back to the default.</summary>
    public (int Page, int PageSize) Normalized()
    {
        var page = Page < 1 ? 1 : Page;
        var size = PageSize <= 0 || PageSize > MaxPageSize ? DefaultPageSize : PageSize;
        return (page, size);
    }
}

public record GoogleLoginRequest(string Code, string RedirectUri);

public record AuthResponse(string Token, UserDto User);

public record UserDto(Guid Id, string Email, string DisplayName, string AvatarUrl, UserRole Role, bool IsApproved, bool IsDisabled, bool IsProfileCompleted, bool HasChangedName);

public record RootFolderDto(Guid Id, string Name, string GoogleDriveFolderId, bool IsPublic, bool IsActive, bool IsAutoAdded);

public record CreateRootFolderRequest(string Name, string GoogleDriveFolderId, bool IsPublic);

public record UpdateRootFolderRequest(string Name, bool IsPublic, bool IsActive);

public record MangaDto(Guid Id, string Title, string OtherTitles, string Description, string Author, string Status, string Genres, string CoverImageFileId, string BannerImageFileId, int ChapterCount, string? LatestChapter, DateTime UpdatedAt, int ViewCount, string? LatestChapterNumber = null, bool? IsNSFW = null);

public record ChapterDto(Guid Id, string Name, int SortOrder, int ImageCount, string? ChapterNumber = null, string? ChapterName = null, string? Slug = null);

public record ChapterDetailDto(Guid Id, Guid MangaId, string Name, int SortOrder, List<ChapterImageDto> Images, bool IsScrambled);

public record ChapterImageDto(Guid Id, string DriveFileId, string FileName, int SortOrder);

public record SyncJobDto(Guid Id, Guid RootFolderId, string RootName, string Status, string? CurrentManga, string? CurrentChapter, int TotalManga, int SyncedManga, int TotalChapter, int SyncedChapter, int TotalImage, int SyncedImage, int Percent, string? Message);

public record CommentDto(Guid Id, string Content, string UserName, string AvatarUrl, DateTime CreatedAt);

public record CreateCommentRequest(string Content);

public record PermissionRequest(Guid TargetId);

public record NotificationDto(Guid Id, string Type, string Title, string Message, string? Link, bool IsRead, DateTime CreatedAt);

public record SyncFolderRequest(string DriveFileId, string? Name);
