using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using WinForms = System.Windows.Forms;

namespace MangaScramble;

public partial class MainWindow : Window
{
    private CancellationTokenSource? _cts;
    private string? _savedKeyHash; // PBKDF2 hash of the last-used master key (from config); plaintext is never stored.
    private static readonly string ConfigPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "scramble-config.json");

    public MainWindow()
    {
        InitializeComponent();
        LoadConfig();
        Log("MangaDrive Image Scramble Tool ready.");
        Log("Thuật toán: Mulberry32 PRNG + Fisher-Yates shuffle (cross-platform với JS/web).");
        Log("Chế độ per-chapter: mỗi subfolder = 1 chapter, xáo bằng masterKey:slug, output PNG + manifest.json.");
        Log($"Config file: {ConfigPath}");
    }

    private int GetGridSize()
    {
        var selected = (cmbGrid.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "4x4";
        return selected switch
        {
            "3x3" => 3,
            "4x4" => 4,
            "5x5" => 5,
            "6x6" => 6,
            "8x8" => 8,
            _ => 4
        };
    }

    private void SetGridCombo(int grid)
    {
        var idx = grid switch { 3 => 0, 4 => 1, 5 => 2, 6 => 3, 8 => 4, _ => 1 };
        cmbGrid.SelectedIndex = idx;
    }

    private void LoadConfig()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var config = JsonSerializer.Deserialize<ScrambleConfig>(json);
                if (config != null)
                {
                    _savedKeyHash = config.KeyHash;
                    SetGridCombo(config.Grid > 0 ? config.Grid : 4);
                    Log($"Loaded config: Grid={config.Grid}x{config.Grid}, MasterKey hash={(string.IsNullOrEmpty(config.KeyHash) ? "(chưa có)" : "đã lưu")}");
                }
            }
        }
        catch { /* Ignore corrupt config */ }
    }

    // Persist only the grid and a verify-only hash of the master key — never the
    // plaintext key. The hash lets us warn on the next run if a different key is typed.
    private void SaveConfig(string masterKey)
    {
        try
        {
            var config = new ScrambleConfig
            {
                KeyHash = KeyHash.Hash(masterKey),
                Grid = GetGridSize()
            };
            var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(ConfigPath, json);
            _savedKeyHash = config.KeyHash;
        }
        catch { /* Ignore save errors */ }
    }

    private void BrowseInput_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new WinForms.FolderBrowserDialog
        {
            Description = "Chọn thư mục chứa ảnh gốc (mỗi subfolder = 1 chapter)",
            UseDescriptionForTitle = true
        };
        if (dialog.ShowDialog() == WinForms.DialogResult.OK)
        {
            txtInputFolder.Text = dialog.SelectedPath;
            if (string.IsNullOrEmpty(txtOutputFolder.Text))
            {
                var parent = Path.GetDirectoryName(dialog.SelectedPath) ?? "";
                var folderName = Path.GetFileName(dialog.SelectedPath);
                txtOutputFolder.Text = Path.Combine(parent, folderName + "_scrambled");
            }
        }
    }

    private void BrowseOutput_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new WinForms.FolderBrowserDialog
        {
            Description = "Chọn thư mục output",
            UseDescriptionForTitle = true
        };
        if (dialog.ShowDialog() == WinForms.DialogResult.OK)
        {
            txtOutputFolder.Text = dialog.SelectedPath;
        }
    }

    private void Preview_Click(object sender, RoutedEventArgs e)
    {
        var inputFolder = txtInputFolder.Text.Trim();
        var masterKey = txtKey.Text.Trim();
        var grid = GetGridSize();

        if (string.IsNullOrEmpty(masterKey))
        {
            System.Windows.MessageBox.Show("Vui lòng nhập Master Key!", "Lỗi", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        if (string.IsNullOrEmpty(inputFolder) || !Directory.Exists(inputFolder))
        {
            System.Windows.MessageBox.Show("Vui lòng chọn thư mục input hợp lệ!", "Lỗi", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var extensions = new[] { "*.jpg", "*.jpeg", "*.png", "*.webp", "*.bmp" };
        string? firstImage = null;
        foreach (var ext in extensions)
        {
            var files = Directory.GetFiles(inputFolder, ext, SearchOption.AllDirectories);
            if (files.Length > 0) { firstImage = files[0]; break; }
        }

        if (firstImage == null)
        {
            System.Windows.MessageBox.Show("Không tìm thấy ảnh trong thư mục input!", "Lỗi", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        try
        {
            // Preview only illustrates the grid effect — the real per-chapter key uses a
            // random slug, so we use a fixed ":preview" suffix here just for display.
            var previewKey = $"{masterKey}:preview";
            using var source = new Bitmap(firstImage);
            imgOriginal.Source = BitmapToImageSource(source);

            bool isScrambleMode = rbScramble.IsChecked == true;
            using var result = isScrambleMode
                ? ImageProcessor.ScrambleImage(source, previewKey, grid)
                : ImageProcessor.UnscrambleImage(source, previewKey, grid);

            imgScrambled.Source = BitmapToImageSource(result);
            Log($"Preview: {Path.GetFileName(firstImage)} | Grid: {grid}x{grid} (dùng khóa minh hoạ ':preview', không phải slug thật)");
        }
        catch (Exception ex)
        {
            Log($"Preview error: {ex.Message}");
        }
    }

    private async void Start_Click(object sender, RoutedEventArgs e)
    {
        var inputFolder = txtInputFolder.Text.Trim();
        var outputFolder = txtOutputFolder.Text.Trim();
        var masterKey = txtKey.Text.Trim();
        var grid = GetGridSize();
        bool isScrambleMode = rbScramble.IsChecked == true;

        if (string.IsNullOrEmpty(masterKey))
        {
            System.Windows.MessageBox.Show("Vui lòng nhập Master Key!", "Lỗi", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        if (string.IsNullOrEmpty(inputFolder) || !Directory.Exists(inputFolder))
        {
            System.Windows.MessageBox.Show("Thư mục input không hợp lệ!", "Lỗi", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        if (string.IsNullOrEmpty(outputFolder))
        {
            System.Windows.MessageBox.Show("Vui lòng chọn thư mục output!", "Lỗi", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        // Unscramble needs a manifest.json in the input folder.
        if (!isScrambleMode && !File.Exists(Path.Combine(inputFolder, "manifest.json")))
        {
            System.Windows.MessageBox.Show(
                "Không tìm thấy manifest.json trong thư mục input. Unscramble cần folder output do tool tạo ra (có manifest.json).",
                "Lỗi", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        // Warn if the typed master key differs from the last-used one (catches typos
        // that would otherwise produce unrecoverable output). Hash is verify-only.
        if (!string.IsNullOrEmpty(_savedKeyHash) && !KeyHash.Verify(masterKey, _savedKeyHash))
        {
            var warn = System.Windows.MessageBox.Show(
                "Master Key khác với lần chạy trước. Nếu gõ sai, ảnh scramble sẽ KHÔNG giải lại được. Tiếp tục?",
                "Cảnh báo Master Key", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (warn != MessageBoxResult.Yes) return;
        }

        if (Directory.Exists(outputFolder) && Directory.GetFiles(outputFolder, "*", SearchOption.AllDirectories).Length > 0)
        {
            var result = System.Windows.MessageBox.Show(
                "Thư mục output đã có file. Tiếp tục sẽ ghi đè. Bạn có muốn tiếp tục?",
                "Xác nhận", MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (result != MessageBoxResult.Yes) return;
        }

        // Save grid + verify-only key hash (no plaintext) before processing.
        SaveConfig(masterKey);

        SetProcessing(true);
        _cts = new CancellationTokenSource();
        var mode = isScrambleMode ? "Scramble" : "Unscramble";

        Log("");
        Log($"=== {mode} (per-chapter) Started ===");
        Log($"Input: {inputFolder}");
        Log($"Output: {outputFolder}");
        Log($"Grid: {grid}x{grid} | Mode: {mode}");

        var progress = new Progress<(int current, int total, string fileName)>(p =>
        {
            progressBar.Maximum = p.total;
            progressBar.Value = p.current;
            txtProgress.Text = $"{p.current}/{p.total}";
            if (p.current % 10 == 0 || p.current == p.total)
                Log($"  [{p.current}/{p.total}] {p.fileName}");
        });

        try
        {
            int count = isScrambleMode
                ? await ImageProcessor.ScramblePerChapterAsync(inputFolder, outputFolder, masterKey, grid, progress, _cts.Token)
                : await ImageProcessor.UnscramblePerChapterAsync(inputFolder, outputFolder, masterKey, progress, _cts.Token);

            Log($"=== Hoàn thành! {count} ảnh đã được xử lý ===");
            System.Windows.MessageBox.Show($"Hoàn thành! {count} ảnh đã được {mode.ToLower()}.",
                "Thành công", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (OperationCanceledException)
        {
            Log("=== Đã hủy ===");
        }
        catch (Exception ex)
        {
            Log($"ERROR: {ex.Message}");
            System.Windows.MessageBox.Show($"Lỗi: {ex.Message}", "Lỗi", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            SetProcessing(false);
            _cts?.Dispose();
            _cts = null;
        }
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        _cts?.Cancel();
        Log("Đang hủy...");
    }

    private void SetProcessing(bool processing)
    {
        btnStart.IsEnabled = !processing;
        btnCancel.IsEnabled = processing;
        btnPreview.IsEnabled = !processing;
        txtInputFolder.IsEnabled = !processing;
        txtOutputFolder.IsEnabled = !processing;
        txtKey.IsEnabled = !processing;
        cmbGrid.IsEnabled = !processing;

        if (!processing)
        {
            progressBar.Value = 0;
            txtProgress.Text = "";
        }
    }

    private void Log(string message)
    {
        txtLog.AppendText(message + "\n");
        txtLog.ScrollToEnd();
    }

    private static BitmapImage BitmapToImageSource(Bitmap bitmap)
    {
        using var memory = new MemoryStream();
        bitmap.Save(memory, System.Drawing.Imaging.ImageFormat.Png);
        memory.Position = 0;
        var bitmapImage = new BitmapImage();
        bitmapImage.BeginInit();
        bitmapImage.StreamSource = memory;
        bitmapImage.CacheOption = BitmapCacheOption.OnLoad;
        bitmapImage.EndInit();
        bitmapImage.Freeze();
        return bitmapImage;
    }
}

public class ScrambleConfig
{
    // No plaintext key on disk. KeyHash is a verify-only PBKDF2 hash of the last-used
    // master key, used solely to warn when a different key is typed this session.
    public string? KeyHash { get; set; }
    public int Grid { get; set; } = 4;
}
