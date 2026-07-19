using System.Security.Claims;
using MangaDrive.Api.Filters;
using MangaDrive.Api.Hubs;
using MangaDrive.Core.DTOs;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/dm")]
[Authorize]
[RequireApproved]
public class DmController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<ChatHub> _hub;

    public DmController(AppDbContext db, IHubContext<ChatHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private Guid UserId => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    private const int MessagePageSize = 30;

    // Store the pair ordered (smaller GUID string first) so a pair is unique.
    private static (Guid u1, Guid u2) OrderPair(Guid a, Guid b)
        => string.CompareOrdinal(a.ToString(), b.ToString()) <= 0 ? (a, b) : (b, a);

    private static string Preview(string content, string type)
    {
        var text = type == "Request" ? $"[Yêu cầu] {content}" : content;
        return text.Length > 100 ? text[..100] : text;
    }

    private async Task<DmConversation> GetOrCreateAsync(Guid otherId)
    {
        var (u1, u2) = OrderPair(UserId, otherId);
        var convo = await _db.DmConversations.FirstOrDefaultAsync(c => c.User1Id == u1 && c.User2Id == u2);
        if (convo == null)
        {
            convo = new DmConversation { User1Id = u1, User2Id = u2 };
            _db.DmConversations.Add(convo);
            await _db.SaveChangesAsync();
        }
        return convo;
    }

    /// <summary>My conversations, newest activity first. Paginated for infinite scroll.</summary>
    [HttpGet("conversations")]
    public async Task<IActionResult> GetConversations([FromQuery] PaginationQuery pagination)
    {
        var (page, pageSize) = pagination.Normalized();

        var me = UserId;
        var baseQuery = _db.DmConversations
            .Where(c => c.User1Id == me || c.User2Id == me);

        var total = await baseQuery.CountAsync();

        var convos = await baseQuery
            .OrderByDescending(c => c.LastMessageAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(c => new
            {
                c.Id,
                OtherId = c.User1Id == me ? c.User2Id : c.User1Id,
                c.LastMessagePreview,
                c.LastMessageAt,
                Unread = c.User1Id == me ? c.User1Unread : c.User2Unread
            })
            .ToListAsync();

        var otherIds = convos.Select(c => c.OtherId).ToList();
        var users = await _db.Users
            .Where(u => otherIds.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.AvatarUrl, u.Role })
            .ToDictionaryAsync(u => u.Id);

        var items = convos.Select(c => (object)new
        {
            id = c.Id,
            other = users.TryGetValue(c.OtherId, out var u)
                ? new { u.Id, u.DisplayName, u.AvatarUrl, u.Role }
                : new { Id = c.OtherId, DisplayName = "Người dùng", AvatarUrl = "", Role = MangaDrive.Core.Entities.UserRole.User },
            lastMessagePreview = c.LastMessagePreview,
            lastMessageAt = c.LastMessageAt,
            unread = c.Unread
        }).ToList();

        return Ok(PaginatedResult<object>.Create(items, total, page, pageSize));
    }

    /// <summary>Total unread DM count for the current user (drives the TopNav badge).</summary>
    [HttpGet("unread-count")]
    public async Task<IActionResult> UnreadCount()
    {
        var me = UserId;
        var total = await _db.DmConversations
            .Where(c => c.User1Id == me || c.User2Id == me)
            .SumAsync(c => c.User1Id == me ? c.User1Unread : c.User2Unread);
        return Ok(total);
    }

    /// <summary>Get-or-create a conversation with the given user.</summary>
    [HttpPost("conversations/with/{userId:guid}")]
    public async Task<IActionResult> StartConversation(Guid userId)
    {
        if (userId == UserId) return BadRequest(new { message = "Không thể tự nhắn cho chính mình" });
        var other = await _db.Users.FindAsync(userId);
        if (other == null) return NotFound(new { message = "Không tìm thấy người dùng" });

        var convo = await GetOrCreateAsync(userId);
        return Ok(new { id = convo.Id, other = new { other.Id, other.DisplayName, other.AvatarUrl, other.Role } });
    }

    /// <summary>Get one conversation + messages. Resets my unread counter.</summary>
    [HttpGet("conversations/{id:guid}")]
    public async Task<IActionResult> GetOne(Guid id)
    {
        var me = UserId;
        var convo = await _db.DmConversations.FindAsync(id);
        if (convo == null) return NotFound();
        if (convo.User1Id != me && convo.User2Id != me) return Forbid();

        // Reset my unread + advance my read cursor so the other side sees "seen".
        var readAt = DateTime.UtcNow;
        if (convo.User1Id == me) { convo.User1Unread = 0; convo.User1LastReadAt = readAt; }
        else if (convo.User2Id == me) { convo.User2Unread = 0; convo.User2LastReadAt = readAt; }
        await _db.SaveChangesAsync();

        var otherId = convo.User1Id == me ? convo.User2Id : convo.User1Id;
        // Tell the other participant their messages up to now have been read.
        await _hub.Clients.Group($"user:{otherId}").SendAsync("DmRead",
            new { conversationId = convo.Id, userId = me, readAt });
        var other = await _db.Users.Where(u => u.Id == otherId)
            .Select(u => new { u.Id, u.DisplayName, u.AvatarUrl, u.Role }).FirstOrDefaultAsync();

        // Newest page only; older messages are fetched on demand (infinite scroll).
        var page = await _db.DmMessages
            .Where(m => m.ConversationId == id)
            .OrderByDescending(m => m.CreatedAt)
            .Take(MessagePageSize + 1)
            .Select(m => new { m.Id, m.SenderId, m.Type, m.Content, m.Status, m.CreatedAt })
            .ToListAsync();

        var hasMore = page.Count > MessagePageSize;
        if (hasMore) page = page.Take(MessagePageSize).ToList();
        page.Reverse(); // ascending (oldest → newest) for rendering

        // The other side's read cursor lets us render "seen" on my own messages.
        var otherLastReadAt = convo.User1Id == me ? convo.User2LastReadAt : convo.User1LastReadAt;

        return Ok(new { id = convo.Id, other, messages = page, hasMore, otherLastReadAt });
    }

    /// <summary>Older messages before a cursor (infinite scroll upward). Returns ascending.</summary>
    [HttpGet("conversations/{id:guid}/messages")]
    public async Task<IActionResult> GetMessages(Guid id, [FromQuery] string? before = null, [FromQuery] int take = MessagePageSize)
    {
        if (take <= 0 || take > 100) take = MessagePageSize;

        var me = UserId;
        var convo = await _db.DmConversations.FindAsync(id);
        if (convo == null) return NotFound();
        if (convo.User1Id != me && convo.User2Id != me) return Forbid();

        var query = _db.DmMessages.Where(m => m.ConversationId == id);
        if (!string.IsNullOrWhiteSpace(before)
            && DateTime.TryParse(before, null, System.Globalization.DateTimeStyles.RoundtripKind, out var beforeDt))
        {
            query = query.Where(m => m.CreatedAt < beforeDt);
        }

        var page = await query
            .OrderByDescending(m => m.CreatedAt)
            .Take(take + 1)
            .Select(m => new { m.Id, m.SenderId, m.Type, m.Content, m.Status, m.CreatedAt })
            .ToListAsync();

        var hasMore = page.Count > take;
        if (hasMore) page = page.Take(take).ToList();
        page.Reverse(); // ascending

        return Ok(new { messages = page, hasMore });
    }

    /// <summary>Send a text message in a conversation.</summary>
    [HttpPost("conversations/{id:guid}/messages")]
    public async Task<IActionResult> SendMessage(Guid id, [FromBody] SendDmDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Content))
            return BadRequest(new { message = "Nội dung không được để trống" });

        var me = UserId;
        var convo = await _db.DmConversations.FindAsync(id);
        if (convo == null) return NotFound();
        if (convo.User1Id != me && convo.User2Id != me) return Forbid();

        // Cap length so a multi-MB body can't bloat storage or the broadcast payload.
        var content = dto.Content.Trim();
        if (content.Length > 2000) content = content[..2000];
        var message = new DmMessage
        {
            ConversationId = convo.Id,
            SenderId = me,
            Type = "Text",
            Content = content
        };
        _db.DmMessages.Add(message);

        convo.LastMessageAt = message.CreatedAt;
        convo.LastMessagePreview = Preview(content, "Text");
        var recipientId = convo.User1Id == me ? convo.User2Id : convo.User1Id;
        if (convo.User1Id == recipientId) convo.User1Unread += 1; else convo.User2Unread += 1;
        await _db.SaveChangesAsync();

        await BroadcastMessage(convo, message, me, recipientId);
        await NotifyRecipient(recipientId, me, "dm_message", "Tin nhắn mới", content);

        return Ok(MessagePayload(message));
    }

    /// <summary>Create a manga request: sends a Request card to the first admin.</summary>
    [HttpPost("requests")]
    public async Task<IActionResult> CreateRequest([FromBody] SendDmDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Content))
            return BadRequest(new { message = "Nội dung không được để trống" });

        var me = UserId;
        var admin = await _db.Users
            .Where(u => u.Role == UserRole.Admin && !u.IsDisabled && u.Id != me)
            .OrderBy(u => u.CreatedAt)
            .FirstOrDefaultAsync();
        if (admin == null) return BadRequest(new { message = "Chưa có admin để gửi yêu cầu" });

        var convo = await GetOrCreateAsync(admin.Id);

        var content = dto.Content.Trim();
        var message = new DmMessage
        {
            ConversationId = convo.Id,
            SenderId = me,
            Type = "Request",
            Content = content,
            Status = "Open"
        };
        _db.DmMessages.Add(message);

        convo.LastMessageAt = message.CreatedAt;
        convo.LastMessagePreview = Preview(content, "Request");
        if (convo.User1Id == admin.Id) convo.User1Unread += 1; else convo.User2Unread += 1;
        await _db.SaveChangesAsync();

        await BroadcastMessage(convo, message, me, admin.Id);

        var user = await _db.Users.FindAsync(me);
        _db.Notifications.Add(new Notification
        {
            UserId = admin.Id,
            Type = "manga_request",
            Title = "Yêu cầu manga mới",
            Message = $"{user?.DisplayName ?? "User"}: {(content.Length > 60 ? content[..60] + "..." : content)}",
            Link = null
        });
        await _db.SaveChangesAsync();

        return Ok(new { conversationId = convo.Id });
    }

    /// <summary>Admin sets the status label on a Request message. Participant + admin only.</summary>
    [HttpPost("messages/{messageId:guid}/status")]
    public async Task<IActionResult> SetStatus(Guid messageId, [FromBody] SetDmStatusDto dto)
    {
        if (dto.Status != "Open" && dto.Status != "Approved" && dto.Status != "Rejected")
            return BadRequest(new { message = "Status không hợp lệ" });

        var me = UserId;
        var meUser = await _db.Users.FindAsync(me);
        if (meUser?.Role != UserRole.Admin) return Forbid();

        var msg = await _db.DmMessages.FindAsync(messageId);
        if (msg == null) return NotFound();
        if (msg.Type != "Request") return BadRequest(new { message = "Chỉ áp dụng cho yêu cầu" });

        var convo = await _db.DmConversations.FindAsync(msg.ConversationId);
        if (convo == null) return NotFound();
        if (convo.User1Id != me && convo.User2Id != me) return Forbid();

        msg.Status = dto.Status;
        await _db.SaveChangesAsync();

        await _hub.Clients.Group($"user:{convo.User1Id}").SendAsync("DmMessageStatus", new { conversationId = convo.Id, messageId = msg.Id, status = msg.Status });
        await _hub.Clients.Group($"user:{convo.User2Id}").SendAsync("DmMessageStatus", new { conversationId = convo.Id, messageId = msg.Id, status = msg.Status });

        var statusText = dto.Status == "Approved" ? "được duyệt" : dto.Status == "Rejected" ? "bị từ chối" : "được mở lại";
        _db.Notifications.Add(new Notification
        {
            UserId = msg.SenderId,
            Type = "manga_request_response",
            Title = $"Yêu cầu của bạn đã {statusText}",
            Message = msg.Content.Length > 60 ? msg.Content[..60] + "..." : msg.Content,
            Link = null
        });
        await _db.SaveChangesAsync();

        return Ok(new { msg.Id, msg.Status });
    }

    private async Task BroadcastMessage(DmConversation convo, DmMessage message, Guid senderId, Guid recipientId)
    {
        var payload = new { conversationId = convo.Id, message = MessagePayload(message) };
        await _hub.Clients.Group($"user:{senderId}").SendAsync("DmMessage", payload);
        await _hub.Clients.Group($"user:{recipientId}").SendAsync("DmMessage", payload);
    }

    private async Task NotifyRecipient(Guid recipientId, Guid senderId, string type, string title, string content)
    {
        var sender = await _db.Users.FindAsync(senderId);
        _db.Notifications.Add(new Notification
        {
            UserId = recipientId,
            Type = type,
            Title = title,
            Message = $"{sender?.DisplayName ?? "Người dùng"}: {(content.Length > 60 ? content[..60] + "..." : content)}",
            Link = null
        });
        await _db.SaveChangesAsync();
    }

    private static object MessagePayload(DmMessage m)
        => new { m.Id, m.SenderId, m.Type, m.Content, m.Status, m.CreatedAt };
}

public record SendDmDto(string Content);
public record SetDmStatusDto(string Status);
