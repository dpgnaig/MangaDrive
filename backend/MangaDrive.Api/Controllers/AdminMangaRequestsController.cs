using System.Security.Claims;
using MangaDrive.Api.Filters;
using MangaDrive.Api.Hubs;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/admin/manga-requests")]
[Authorize]
[RequireAdmin]
public class AdminMangaRequestsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<RequestsHub> _hub;

    public AdminMangaRequestsController(AppDbContext db, IHubContext<RequestsHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    private Guid UserId => Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    /// <summary>
    /// List all conversations, newest activity first.
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var conversations = await _db.RequestConversations
            .Include(c => c.User)
            .OrderByDescending(c => c.LastMessageAt)
            .Select(c => new
            {
                c.Id,
                c.Status,
                c.LastMessagePreview,
                c.LastMessageAt,
                c.AdminUnread,
                User = new
                {
                    c.User.Id,
                    c.User.DisplayName,
                    c.User.Email,
                    c.User.AvatarUrl
                }
            })
            .ToListAsync();

        return Ok(conversations);
    }

    /// <summary>
    /// Get one conversation + messages. Resets admin's unread counter.
    /// </summary>
    [HttpGet("{conversationId:guid}")]
    public async Task<IActionResult> GetOne(Guid conversationId)
    {
        var convo = await _db.RequestConversations
            .Include(c => c.User)
            .FirstOrDefaultAsync(c => c.Id == conversationId);
        if (convo == null) return NotFound();

        if (convo.AdminUnread != 0)
        {
            convo.AdminUnread = 0;
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
            status = convo.Status,
            user = new { convo.User.Id, convo.User.DisplayName, convo.User.Email, convo.User.AvatarUrl },
            messages
        });
    }

    /// <summary>
    /// Admin replies to a conversation.
    /// </summary>
    [HttpPost("{conversationId:guid}/messages")]
    public async Task<IActionResult> SendMessage(Guid conversationId, [FromBody] AdminSendRequestMessageDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Content))
            return BadRequest(new { message = "Nội dung không được để trống" });

        var convo = await _db.RequestConversations.FindAsync(conversationId);
        if (convo == null) return NotFound();

        var content = dto.Content.Trim();
        var message = new RequestMessage
        {
            ConversationId = convo.Id,
            SenderId = UserId,
            SenderRole = "Admin",
            Content = content
        };
        _db.RequestMessages.Add(message);

        convo.LastMessageAt = message.CreatedAt;
        convo.LastMessagePreview = content.Length > 100 ? content[..100] : content;
        convo.MemberUnread += 1;
        await _db.SaveChangesAsync();

        var payload = new { message.Id, message.SenderRole, message.Content, message.CreatedAt, message.Status };
        await _hub.Clients.Group(convo.Id.ToString()).SendAsync("NewMessage", payload);

        // Notify the member (the /requests route is gone — chat opens via the floating bubble)
        _db.Notifications.Add(new Notification
        {
            UserId = convo.UserId,
            Type = "manga_request_response",
            Title = "Admin đã phản hồi yêu cầu",
            Message = content.Length > 60 ? content[..60] + "..." : content,
            Link = null
        });
        await _db.SaveChangesAsync();

        return Ok(payload);
    }

    /// <summary>
    /// Set the status label on a single member message.
    /// </summary>
    [HttpPost("messages/{messageId:guid}/status")]
    public async Task<IActionResult> SetMessageStatus(Guid messageId, [FromBody] SetStatusDto dto)
    {
        if (dto.Status != "Open" && dto.Status != "Approved" && dto.Status != "Rejected")
            return BadRequest(new { message = "Status không hợp lệ" });

        var msg = await _db.RequestMessages.FindAsync(messageId);
        if (msg == null) return NotFound();

        msg.Status = dto.Status;
        await _db.SaveChangesAsync();

        await _hub.Clients.Group(msg.ConversationId.ToString())
            .SendAsync("MessageStatusChanged", new { messageId = msg.Id, status = msg.Status });

        // Notify the member their request was labelled
        var convo = await _db.RequestConversations.FindAsync(msg.ConversationId);
        if (convo != null)
        {
            var statusText = dto.Status == "Approved" ? "được duyệt" : dto.Status == "Rejected" ? "bị từ chối" : "được mở lại";
            _db.Notifications.Add(new Notification
            {
                UserId = convo.UserId,
                Type = "manga_request_response",
                Title = $"Yêu cầu của bạn đã {statusText}",
                Message = msg.Content.Length > 60 ? msg.Content[..60] + "..." : msg.Content,
                Link = null
            });
            await _db.SaveChangesAsync();
        }

        return Ok(new { msg.Id, msg.Status });
    }

    /// <summary>
    /// Delete a conversation and its messages.
    /// </summary>
    [HttpDelete("{conversationId:guid}")]
    public async Task<IActionResult> Delete(Guid conversationId)
    {
        var convo = await _db.RequestConversations.FindAsync(conversationId);
        if (convo == null) return NotFound();

        var messages = _db.RequestMessages.Where(m => m.ConversationId == conversationId);
        _db.RequestMessages.RemoveRange(messages);
        _db.RequestConversations.Remove(convo);
        await _db.SaveChangesAsync();

        return Ok();
    }
}

public record AdminSendRequestMessageDto(string Content);
public record SetStatusDto(string Status);
