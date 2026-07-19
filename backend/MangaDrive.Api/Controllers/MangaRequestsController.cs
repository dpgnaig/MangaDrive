using System.Security.Claims;
using MangaDrive.Api.Hubs;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/manga-requests")]
[Authorize]
public class MangaRequestsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<RequestsHub> _hub;

    public MangaRequestsController(AppDbContext db, IHubContext<RequestsHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private Guid UserId => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    /// <summary>
    /// Get (or create) the caller's conversation with admin, plus its messages.
    /// Resets the member's unread counter.
    /// </summary>
    [HttpGet("conversation")]
    public async Task<IActionResult> GetConversation()
    {
        var convo = await _db.RequestConversations.FirstOrDefaultAsync(c => c.UserId == UserId);
        if (convo == null)
        {
            convo = new RequestConversation { UserId = UserId };
            _db.RequestConversations.Add(convo);
            await _db.SaveChangesAsync();
        }
        else if (convo.MemberUnread != 0)
        {
            convo.MemberUnread = 0;
            await _db.SaveChangesAsync();
        }

        var messages = await _db.RequestMessages
            .Where(m => m.ConversationId == convo.Id)
            .OrderBy(m => m.CreatedAt)
            .Select(m => new { m.Id, m.SenderRole, m.Content, m.CreatedAt, m.Status })
            .ToListAsync();

        return Ok(new
        {
            id = convo.Id,
            messages
        });
    }

    /// <summary>
    /// Send a message to admin. Appends to the caller's conversation.
    /// </summary>
    [HttpPost("messages")]
    public async Task<IActionResult> SendMessage([FromBody] SendRequestMessageDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Content))
            return BadRequest(new { message = "Nội dung không được để trống" });

        var convo = await _db.RequestConversations.FirstOrDefaultAsync(c => c.UserId == UserId);
        if (convo == null)
        {
            convo = new RequestConversation { UserId = UserId };
            _db.RequestConversations.Add(convo);
            await _db.SaveChangesAsync();
        }

        var content = dto.Content.Trim();
        var message = new RequestMessage
        {
            ConversationId = convo.Id,
            SenderId = UserId,
            SenderRole = "Member",
            Content = content
        };
        _db.RequestMessages.Add(message);

        convo.LastMessageAt = message.CreatedAt;
        convo.LastMessagePreview = content.Length > 100 ? content[..100] : content;
        convo.AdminUnread += 1;
        await _db.SaveChangesAsync();

        var payload = new { message.Id, message.SenderRole, message.Content, message.CreatedAt, message.Status };
        await _hub.Clients.Group(convo.Id.ToString()).SendAsync("NewMessage", payload);

        // Notify all admins
        var user = await _db.Users.FindAsync(UserId);
        var admins = await _db.Users.Where(u => u.Role == UserRole.Admin).Select(u => u.Id).ToListAsync();
        foreach (var adminId in admins)
        {
            _db.Notifications.Add(new Notification
            {
                UserId = adminId,
                Type = "manga_request",
                Title = "Tin nhắn yêu cầu mới",
                Message = $"{user?.DisplayName ?? "User"}: {(content.Length > 60 ? content[..60] + "..." : content)}",
                Link = "/admin?tab=requests"
            });
        }
        if (admins.Count > 0) await _db.SaveChangesAsync();

        return Ok(payload);
    }
}

public record SendRequestMessageDto(string Content);
