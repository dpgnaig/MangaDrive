using Microsoft.Extensions.Logging;
using System.IO;

namespace MangaMetadataScraper.Infrastructure.Logging;

/// <summary>
/// Logger đơn giản ghi log vào file trong thư mục AppData.
/// </summary>
public sealed class FileLogger : ILogger
{
    private readonly string _categoryName;
    private readonly string _filePath;
    private static readonly object FileLock = new();

    public FileLogger(string categoryName, string filePath)
    {
        _categoryName = categoryName;
        _filePath = filePath;
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Debug;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel)) return;

        var message = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{logLevel,-11}] [{_categoryName}] {formatter(state, exception)}";
        if (exception is not null)
            message += $"\n  Exception: {exception}";

        lock (FileLock)
        {
            File.AppendAllText(_filePath, message + Environment.NewLine);
        }
    }
}

[ProviderAlias("File")]
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _filePath;

    public FileLoggerProvider(string? filePath = null)
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MangaMetadataScraper");
        Directory.CreateDirectory(dir);

        _filePath = filePath ?? Path.Combine(dir, $"log_{DateTime.Now:yyyyMMdd}.txt");
    }

    public ILogger CreateLogger(string categoryName) =>
        new FileLogger(categoryName, _filePath);

    public void Dispose() { }
}

public static class FileLoggerExtensions
{
    public static ILoggingBuilder AddFileLogger(
        this ILoggingBuilder builder,
        string? filePath = null)
    {
        builder.AddProvider(new FileLoggerProvider(filePath));
        return builder;
    }
}
