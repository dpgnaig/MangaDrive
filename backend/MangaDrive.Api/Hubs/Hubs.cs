using System.Security.Claims;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Hubs;

[Authorize]
public class SyncHub : Hub { }

// Per-manga comment broadcast. Comments are readable by any approved user, so a
// manga group carries no private data — but require auth + a real manga id so an
// anonymous client can't connect and join arbitrary groups.
[Authorize]
public class CommentHub : Hub
{
    private readonly AppDbContext _db;

    public CommentHub(AppDbContext db) => _db = db;

    public async Task JoinMangaGroup(string mangaId)
    {
        if (!Guid.TryParse(mangaId, out var id)) return;
        if (!await _db.Mangas.AnyAsync(m => m.Id == id)) return;
        await Groups.AddToGroupAsync(Context.ConnectionId, mangaId);
    }

    public async Task LeaveMangaGroup(string mangaId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, mangaId);
}

// Request threads are private (one member ↔ admins). Only join a conversation
// group if the caller is that conversation's member or an admin — otherwise a
// client could join any conversation id and eavesdrop on its messages.
[Authorize]
public class RequestsHub : Hub
{
    private readonly AppDbContext _db;

    public RequestsHub(AppDbContext db) => _db = db;

    public async Task JoinConversation(string conversationId)
    {
        if (!Guid.TryParse(conversationId, out var convoId)) return;
        var userId = Context.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (userId == null || !Guid.TryParse(userId, out var uid)) return;

        var user = await _db.Users.FindAsync(uid);
        if (user == null || user.IsDisabled) return;

        // Admins may follow any request thread; a member only their own.
        if (user.Role != UserRole.Admin)
        {
            var isParticipant = await _db.RequestConversations
                .AnyAsync(c => c.Id == convoId && c.UserId == uid);
            if (!isParticipant) return;
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, conversationId);
    }

    public async Task LeaveConversation(string conversationId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, conversationId);
}

// General direct-message hub. Each connection is auto-joined to a group
// keyed by the caller's user id ("user:{guid}") so DM writes can be pushed
// to both participants without per-conversation join/leave.
[Authorize]
public class ChatHub : Hub
{
    private readonly AppDbContext _db;

    public ChatHub(AppDbContext db) => _db = db;

    public override async Task OnConnectedAsync()
    {
        var userId = Context.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        // Reject disabled accounts at the handshake so a still-valid token can't keep
        // a banned user on realtime DMs until it expires.
        if (string.IsNullOrEmpty(userId) || !Guid.TryParse(userId, out var uid))
        {
            Context.Abort();
            return;
        }
        var user = await _db.Users.FindAsync(uid);
        if (user == null || user.IsDisabled)
        {
            Context.Abort();
            return;
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{userId}");
        await base.OnConnectedAsync();
    }
}
