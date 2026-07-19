using Google.Apis.Auth.OAuth2;
using Google.Apis.Drive.v3;
using Google.Apis.Http;
using Google.Apis.Services;
using MangaDrive.Core.Interfaces;
using Microsoft.Extensions.Configuration;

namespace MangaDrive.Infrastructure.Services;

public class GoogleDriveService : IGoogleDriveService
{
    private readonly DriveService _drive;

    public string ServiceAccountEmail { get; }

    public GoogleDriveService(IConfiguration config)
    {
        var keyPath = config["Google:ServiceAccountKeyPath"]!;
        var factory = new UnsafeHttpClientFactory();

        // Load service account credential with custom HttpClientFactory for SSL bypass
        var credential = GoogleCredential.FromFile(keyPath)
            .CreateScoped(DriveService.ScopeConstants.DriveReadonly)
            .UnderlyingCredential as ServiceAccountCredential;

        ServiceAccountEmail = credential!.Id;

        // Rebuild credential with custom HttpClientFactory so token refresh also bypasses SSL
        var newCredential = new ServiceAccountCredential(
            new ServiceAccountCredential.Initializer(credential!.Id)
            {
                Key = credential.Key,
                Scopes = credential.Scopes,
                User = credential.User,
                HttpClientFactory = factory
            });

        _drive = new DriveService(new BaseClientService.Initializer
        {
            HttpClientInitializer = newCredential,
            HttpClientFactory = factory
        });
    }

    public async Task<List<DriveFile>> ListFoldersAsync(string parentFolderId)
    {
        return await ListAllAsync($"'{parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
    }

    public async Task<List<DriveFile>> ListFilesAsync(string parentFolderId)
    {
        return await ListAllAsync($"'{parentFolderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false");
    }

    /// <param name="serverOrderBy">
    /// When true, ask Drive to sort by name. Leave false for the "shared with me"
    /// corpus: combining orderBy with sharedWithMe + IncludeItemsFromAllDrives makes
    /// the API silently drop items, so we sort those client-side instead.
    /// </param>
    private async Task<List<DriveFile>> ListAllAsync(string query, bool serverOrderBy = true)
    {
        var all = new List<DriveFile>();
        string? pageToken = null;
        do
        {
            var request = _drive.Files.List();
            request.Q = query;
            request.Fields = "nextPageToken, files(id,name,mimeType,createdTime,modifiedTime)";
            request.PageSize = 1000;
            if (serverOrderBy) request.OrderBy = "name";
            // Include items that live in Shared Drives, not just My Drive. Without these
            // two flags the API silently drops any folder/file belonging to a Shared Drive.
            request.SupportsAllDrives = true;
            request.IncludeItemsFromAllDrives = true;
            if (pageToken != null) request.PageToken = pageToken;
            var result = await request.ExecuteAsync();
            if (result.Files != null)
                all.AddRange(result.Files.Select(f => new DriveFile(
                    f.Id, f.Name, f.MimeType,
                    f.CreatedTimeDateTimeOffset?.UtcDateTime,
                    f.ModifiedTimeDateTimeOffset?.UtcDateTime)));
            pageToken = result.NextPageToken;
        } while (pageToken != null);
        return all;
    }

    public async Task<string> GetStartPageTokenAsync()
    {
        var response = await _drive.Changes.GetStartPageToken().ExecuteAsync();
        return response.StartPageTokenValue;
    }

    public async Task<(List<DriveChange> Changes, string NewPageToken)> GetChangesAsync(string pageToken)
    {
        var allChanges = new List<DriveChange>();
        var currentToken = pageToken;

        while (true)
        {
            var request = _drive.Changes.List(currentToken);
            request.Fields = "nextPageToken, newStartPageToken, changes(fileId, file(name, mimeType, parents), removed)";
            request.PageSize = 1000;
            request.IncludeRemoved = true;

            var response = await request.ExecuteAsync();

            if (response.Changes != null)
            {
                foreach (var change in response.Changes)
                {
                    allChanges.Add(new DriveChange(
                        change.FileId,
                        change.File?.Name,
                        change.File?.MimeType,
                        change.Removed ?? false,
                        change.File?.Parents as IReadOnlyList<string>));
                }
            }

            if (response.NewStartPageToken != null)
            {
                // No more pages, return the new start token for next poll
                return (allChanges, response.NewStartPageToken);
            }

            currentToken = response.NextPageToken;
        }
    }

    public async Task<List<DriveFile>> ListSharedFoldersAsync()
    {
        // No server-side orderBy here: with sharedWithMe + IncludeItemsFromAllDrives,
        // adding orderBy causes Drive to drop folders from the result. Sort in memory.
        var folders = await ListAllAsync(
            "sharedWithMe=true and mimeType='application/vnd.google-apps.folder' and trashed=false",
            serverOrderBy: false);
        return folders.OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async Task<string?> GetFileContentAsync(string fileId)
    {
        using var stream = new MemoryStream();
        await _drive.Files.Get(fileId).DownloadAsync(stream);
        stream.Position = 0;
        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync();
    }

    public async Task<Stream> DownloadFileAsync(string fileId)
    {
        var stream = new MemoryStream();
        await _drive.Files.Get(fileId).DownloadAsync(stream);
        stream.Position = 0;
        return stream;
    }
}


/// <summary>
/// HttpClientFactory that bypasses SSL validation for environments behind proxy/VPN.
/// </summary>
internal class UnsafeHttpClientFactory : Google.Apis.Http.IHttpClientFactory
{
    public ConfigurableHttpClient CreateHttpClient(CreateHttpClientArgs args)
    {
        var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
        };
        var configurableHandler = new ConfigurableMessageHandler(handler);
        var client = new ConfigurableHttpClient(configurableHandler);
        foreach (var initializer in args.Initializers)
        {
            initializer.Initialize(client);
        }
        return client;
    }
}
