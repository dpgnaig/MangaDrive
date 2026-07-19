using MangaDrive.Api.Hubs;
using MangaDrive.Core.Interfaces;
using Microsoft.AspNetCore.SignalR;

namespace MangaDrive.Api.Services;

public class SyncNotifier : ISyncNotifier
{
    private readonly IHubContext<SyncHub> _hub;
    public SyncNotifier(IHubContext<SyncHub> hub) => _hub = hub;

    public Task NotifyProgress(object progress)
        => _hub.Clients.All.SendAsync("SyncProgress", progress);
}
