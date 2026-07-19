using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace MangaScramble;

/// <summary>
/// One chapter entry in the output manifest.json. Field names/order match the web
/// tool (frontend AdminScrambleTab) exactly so the output is interchangeable.
/// </summary>
public class ChapterManifestEntry
{
    public string Original { get; set; } = "";
    public string Slug { get; set; } = "";
    public int Grid { get; set; }
    public int FileCount { get; set; }
}

/// <summary>
/// Handles image scramble/unscramble operations using System.Drawing.
/// </summary>
public static class ImageProcessor
{
    /// <summary>
    /// Scramble an image: split into grid tiles and rearrange them according to the key.
    /// </summary>
    public static Bitmap ScrambleImage(Bitmap source, string key, int grid)
    {
        var permutation = ScrambleAlgorithm.GeneratePermutation(key, grid);
        return RearrangeTiles(source, permutation, grid);
    }

    /// <summary>
    /// Unscramble an image: reverse the tile rearrangement.
    /// </summary>
    public static Bitmap UnscrambleImage(Bitmap source, string key, int grid)
    {
        var inversePermutation = ScrambleAlgorithm.GenerateInversePermutation(key, grid);
        return RearrangeTiles(source, inversePermutation, grid);
    }

    private static Bitmap RearrangeTiles(Bitmap source, int[] permutation, int grid)
    {
        int tileWidth = source.Width / grid;
        int tileHeight = source.Height / grid;

        // Output image has same dimensions
        var output = new Bitmap(source.Width, source.Height, source.PixelFormat);
        output.SetResolution(source.HorizontalResolution, source.VerticalResolution);

        using var g = Graphics.FromImage(output);
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;

        for (int destIdx = 0; destIdx < permutation.Length; destIdx++)
        {
            int srcIdx = permutation[destIdx];

            int srcCol = srcIdx % grid;
            int srcRow = srcIdx / grid;
            int destCol = destIdx % grid;
            int destRow = destIdx / grid;

            var srcRect = new Rectangle(srcCol * tileWidth, srcRow * tileHeight, tileWidth, tileHeight);
            var destRect = new Rectangle(destCol * tileWidth, destRow * tileHeight, tileWidth, tileHeight);

            g.DrawImage(source, destRect, srcRect, GraphicsUnit.Pixel);
        }

        return output;
    }

    /// <summary>
    /// Process an entire folder of images, scrambling each one.
    /// </summary>
    public static async Task<int> ScrambleFolderAsync(
        string inputFolder,
        string outputFolder,
        string key,
        int grid,
        int quality,
        IProgress<(int current, int total, string fileName)>? progress = null,
        CancellationToken ct = default)
    {
        if (!Directory.Exists(inputFolder))
            throw new DirectoryNotFoundException($"Input folder not found: {inputFolder}");

        Directory.CreateDirectory(outputFolder);

        var imageFiles = GetImageFiles(inputFolder);
        int total = imageFiles.Length;
        int processed = 0;

        foreach (var file in imageFiles)
        {
            ct.ThrowIfCancellationRequested();

            var relativePath = Path.GetRelativePath(inputFolder, file);
            var outputPath = Path.Combine(outputFolder, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);

            using var source = new Bitmap(file);
            using var scrambled = ScrambleImage(source, key, grid);

            SaveImage(scrambled, outputPath, quality);
            processed++;
            progress?.Report((processed, total, relativePath));
        }

        return processed;
    }

    /// <summary>
    /// Process recursively: scramble all images in subfolders (manga chapter structure).
    /// InputFolder structure: MangaName/Chapter1/001.jpg, MangaName/Chapter2/001.jpg, etc.
    /// </summary>
    public static async Task<int> ScrambleRecursiveAsync(
        string inputFolder,
        string outputFolder,
        string key,
        int grid,
        int quality,
        IProgress<(int current, int total, string fileName)>? progress = null,
        CancellationToken ct = default)
    {
        if (!Directory.Exists(inputFolder))
            throw new DirectoryNotFoundException($"Input folder not found: {inputFolder}");

        Directory.CreateDirectory(outputFolder);

        var imageFiles = GetImageFiles(inputFolder);
        int total = imageFiles.Length;
        int processed = 0;

        await Task.Run(() =>
        {
            foreach (var file in imageFiles)
            {
                ct.ThrowIfCancellationRequested();

                var relativePath = Path.GetRelativePath(inputFolder, file);
                var outputPath = Path.Combine(outputFolder, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);

                using var source = new Bitmap(file);
                using var scrambled = ScrambleImage(source, key, grid);

                SaveImage(scrambled, outputPath, quality);
                processed++;
                progress?.Report((processed, total, relativePath));
            }
        }, ct);

        return processed;
    }

    // JSON shape must match the web tool: camelCase keys {original, slug, grid, fileCount}.
    private static readonly JsonSerializerOptions ManifestJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    // Generate a unique chapter slug identical in shape to the web tool:
    // "chapter-" + 6 random bytes as 12 lowercase hex chars.
    private static string NewSlug()
    {
        var bytes = RandomNumberGenerator.GetBytes(6);
        return "chapter-" + Convert.ToHexString(bytes).ToLowerInvariant();
    }

    // Direct image files inside a folder (non-recursive), natural-sorted by name to
    // match the web tool's localeCompare({numeric:true}).
    private static string[] GetDirectImageFiles(string folder)
    {
        var extensions = new[] { "*.jpg", "*.jpeg", "*.png", "*.webp", "*.bmp" };
        return extensions
            .SelectMany(ext => Directory.GetFiles(folder, ext, SearchOption.TopDirectoryOnly))
            .OrderBy(f => Path.GetFileName(f), NaturalComparer.Instance)
            .ToArray();
    }

    /// <summary>
    /// Per-chapter scramble matching the web tool. Each direct subfolder of the input =
    /// one chapter (if none, the input folder itself is one chapter). Every chapter gets
    /// a unique slug and is scrambled with key "masterKey:slug", written as
    /// &lt;output&gt;/&lt;slug&gt;/NNN.png (PNG lossless). A manifest.json is written at the output root.
    /// </summary>
    public static async Task<int> ScramblePerChapterAsync(
        string inputFolder,
        string outputFolder,
        string masterKey,
        int grid,
        IProgress<(int current, int total, string fileName)>? progress = null,
        CancellationToken ct = default)
    {
        if (!Directory.Exists(inputFolder))
            throw new DirectoryNotFoundException($"Input folder not found: {inputFolder}");

        Directory.CreateDirectory(outputFolder);
        var baseKey = masterKey.Trim();

        // Chapters = direct subfolders, else the input folder itself.
        var subDirs = Directory.GetDirectories(inputFolder)
            .OrderBy(d => Path.GetFileName(d), NaturalComparer.Instance)
            .ToArray();
        var chapterDirs = subDirs.Length > 0 ? subDirs : new[] { inputFolder };

        // Pre-scan files per chapter for an accurate progress total.
        var chapters = new List<(string name, string[] files)>();
        int total = 0;
        foreach (var dir in chapterDirs)
        {
            var files = GetDirectImageFiles(dir);
            if (files.Length == 0) continue;
            chapters.Add((Path.GetFileName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)), files));
            total += files.Length;
        }

        var manifest = new List<ChapterManifestEntry>();
        int processed = 0;

        await Task.Run(() =>
        {
            foreach (var (name, files) in chapters)
            {
                ct.ThrowIfCancellationRequested();
                var slug = NewSlug();
                var key = $"{baseKey}:{slug}";
                var outChapterDir = Path.Combine(outputFolder, slug);
                Directory.CreateDirectory(outChapterDir);

                int seq = 1;
                foreach (var file in files)
                {
                    ct.ThrowIfCancellationRequested();
                    using var source = new Bitmap(file);
                    using var scrambled = ScrambleImage(source, key, grid);
                    var outPath = Path.Combine(outChapterDir, $"{seq:D3}.png");
                    scrambled.Save(outPath, ImageFormat.Png);
                    seq++;
                    processed++;
                    progress?.Report((processed, total, $"{name} → {slug}"));
                }

                manifest.Add(new ChapterManifestEntry { Original = name, Slug = slug, Grid = grid, FileCount = files.Length });
            }

            var manifestPath = Path.Combine(outputFolder, "manifest.json");
            File.WriteAllText(manifestPath, JsonSerializer.Serialize(manifest, ManifestJsonOptions));
        }, ct);

        return processed;
    }

    /// <summary>
    /// Per-chapter unscramble: reads &lt;input&gt;/manifest.json, and for each entry uses
    /// key "masterKey:slug" + entry grid to restore &lt;input&gt;/&lt;slug&gt;/* back to
    /// &lt;output&gt;/&lt;original&gt;/NNN.png. Verifies that a scramble round-trips.
    /// </summary>
    public static async Task<int> UnscramblePerChapterAsync(
        string inputFolder,
        string outputFolder,
        string masterKey,
        IProgress<(int current, int total, string fileName)>? progress = null,
        CancellationToken ct = default)
    {
        var manifestPath = Path.Combine(inputFolder, "manifest.json");
        if (!File.Exists(manifestPath))
            throw new FileNotFoundException($"manifest.json not found in {inputFolder}");

        var manifest = JsonSerializer.Deserialize<List<ChapterManifestEntry>>(
            File.ReadAllText(manifestPath), ManifestJsonOptions) ?? new List<ChapterManifestEntry>();

        Directory.CreateDirectory(outputFolder);
        var baseKey = masterKey.Trim();

        // Pre-scan for progress total.
        var chapters = new List<(ChapterManifestEntry entry, string[] files)>();
        int total = 0;
        foreach (var entry in manifest)
        {
            var chapterDir = Path.Combine(inputFolder, entry.Slug);
            if (!Directory.Exists(chapterDir)) continue;
            var files = GetDirectImageFiles(chapterDir);
            if (files.Length == 0) continue;
            chapters.Add((entry, files));
            total += files.Length;
        }

        int processed = 0;

        await Task.Run(() =>
        {
            foreach (var (entry, files) in chapters)
            {
                ct.ThrowIfCancellationRequested();
                var key = $"{baseKey}:{entry.Slug}";
                var outChapterDir = Path.Combine(outputFolder, entry.Original);
                Directory.CreateDirectory(outChapterDir);

                int seq = 1;
                foreach (var file in files)
                {
                    ct.ThrowIfCancellationRequested();
                    using var source = new Bitmap(file);
                    using var restored = UnscrambleImage(source, key, entry.Grid);
                    var outPath = Path.Combine(outChapterDir, $"{seq:D3}.png");
                    restored.Save(outPath, ImageFormat.Png);
                    seq++;
                    processed++;
                    progress?.Report((processed, total, $"{entry.Slug} → {entry.Original}"));
                }
            }
        }, ct);

        return processed;
    }

    private static string[] GetImageFiles(string folder)
    {
        var extensions = new[] { "*.jpg", "*.jpeg", "*.png", "*.webp", "*.bmp" };
        return extensions
            .SelectMany(ext => Directory.GetFiles(folder, ext, SearchOption.AllDirectories))
            .OrderBy(f => f)
            .ToArray();
    }

    private static void SaveImage(Bitmap image, string outputPath, int quality)
    {
        var ext = Path.GetExtension(outputPath).ToLowerInvariant();
        var format = ext switch
        {
            ".png" => ImageFormat.Png,
            ".bmp" => ImageFormat.Bmp,
            _ => ImageFormat.Jpeg
        };

        if (format == ImageFormat.Jpeg)
        {
            var encoder = ImageCodecInfo.GetImageEncoders().First(e => e.FormatID == ImageFormat.Jpeg.Guid);
            var encoderParams = new EncoderParameters(1);
            encoderParams.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
            image.Save(outputPath, encoder, encoderParams);
        }
        else
        {
            image.Save(outputPath, format);
        }
    }
}
