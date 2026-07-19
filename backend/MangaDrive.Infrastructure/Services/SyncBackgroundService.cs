using System.Threading.Channels;
using MangaDrive.Core.Interfaces;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace MangaDrive.Infrastructure.Services;

public record SyncRequest(Guid Id, SyncRequestType Type);
public enum SyncRequestType { RootFolder, Manga }

public class SyncBackgroundService : BackgroundService
{
    public static readonly Channel<SyncRequest> Queue = Channel.CreateUnbounded<SyncRequest>();

    // Keep legacy channel for backward compatibility
    public static readonly Channel<Guid> LegacyQueue = Channel.CreateUnbounded<Guid>();

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<SyncBackgroundService> _logger;

    public SyncBackgroundService(IServiceScopeFactory scopeFactory, ILogger<SyncBackgroundService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Process both channels concurrently
        var task1 = ProcessQueue(stoppingToken);
        var task2 = ProcessLegacyQueue(stoppingToken);
        await Task.WhenAll(task1, task2);
    }

    private async Task ProcessQueue(CancellationToken stoppingToken)
    {
        await foreach (var request in Queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var syncService = scope.ServiceProvider.GetRequiredService<IMangaSyncService>();

                switch (request.Type)
                {
                    case SyncRequestType.RootFolder:
                        await syncService.SyncRootFolderAsync(request.Id, stoppingToken);
                        break;
                    case SyncRequestType.Manga:
                        await syncService.SyncSingleMangaAsync(request.Id, stoppingToken);
                        break;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Background sync failed for {Type} {Id}", request.Type, request.Id);
            }
        }
    }

    private async Task ProcessLegacyQueue(CancellationToken stoppingToken)
    {
        await foreach (var rootFolderId in LegacyQueue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var syncService = scope.ServiceProvider.GetRequiredService<IMangaSyncService>();
                await syncService.SyncRootFolderAsync(rootFolderId, stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Background sync failed for {Id}", rootFolderId);
            }
        }
    }
}
