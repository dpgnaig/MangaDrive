using System.Text.Json;
using System.Text.RegularExpressions;
using MangaDrive.Core.Interfaces;

namespace MangaDrive.Infrastructure.Services;

/// <summary>
/// Shared scramble-manifest helpers used by both MangaSyncService (actual sync) and
/// the admin controllers that need to tell a "real" unsynced chapter folder apart
/// from an orphan left by an aborted scramble upload (Drive folder created, but the
/// upload never got far enough to write its manifest.json entry). Kept as a single
/// source of truth so the slug pattern/manifest parsing can't drift between them.
/// </summary>
public static class ScrambleManifestUtil
{
    // Matches current 12-hex slugs and legacy `chapter-` prefixed slugs.
    public static readonly Regex SlugPattern = new(@"^(?:chapter-)?[0-9a-f]{12}$", RegexOptions.Compiled);

    private record ManifestEntry(string? Slug);

    /// <summary>
    /// Reads manifest.json (if present in `files`) and returns the set of slugs it
    /// contains. A slug-pattern Drive folder whose name is NOT in this set has never
    /// been recorded in the manifest — either the upload is still in progress or it
    /// was aborted, leaving an orphan folder behind.
    /// </summary>
    public static async Task<HashSet<string>> ReadManifestSlugsAsync(IGoogleDriveService drive, List<DriveFile> files)
    {
        var manifestFile = files.FirstOrDefault(f => f.Name == "manifest.json");
        if (manifestFile == null) return new();

        try
        {
            var json = await drive.GetFileContentAsync(manifestFile.Id);
            if (string.IsNullOrEmpty(json)) return new();

            var entries = JsonSerializer.Deserialize<List<ManifestEntry>>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
            return entries.Where(e => !string.IsNullOrEmpty(e.Slug)).Select(e => e.Slug!).ToHashSet();
        }
        catch
        {
            return new();
        }
    }
}
