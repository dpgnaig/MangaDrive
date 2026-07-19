namespace MangaDrive.Core.Interfaces;

public interface ISyncNotifier
{
    Task NotifyProgress(object progress);
}
