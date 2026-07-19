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
[Route("api/mangas/{mangaId:guid}/comments")]
[Authorize]
[RequireApproved]
public class CommentsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<CommentHub> _hub;

    public CommentsController(AppDbContext db, IHubContext<CommentHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    [HttpGet]
    public async Task<IActionResult> GetAll(Guid mangaId)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

        var comments = await _db.Comments
            .Where(c => c.MangaId == mangaId)
            .Include(c => c.User)
            .Include(c => c.Reactions)
            .OrderByDescending(c => c.CreatedAt)
            .ToListAsync();

        var result = comments.Select(c => CommentMapperHelper.MapToDto(c, userId)).ToList();
        return Ok(result);
    }

    [HttpPost]
    public async Task<IActionResult> Create(Guid mangaId, [FromBody] CreateCommentRequest req)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var user = await _db.Users.FindAsync(userId);
        if (user == null) return Unauthorized();

        // Cap length so a multi-MB body can't bloat storage or the broadcast payload.
        var content = (req.Content ?? string.Empty).Trim();
        if (content.Length == 0) return BadRequest(new { message = "Nội dung không được để trống" });
        if (content.Length > 2000) content = content[..2000];

        var comment = new Comment
        {
            MangaId = mangaId,
            UserId = userId,
            Content = content,
            ParentCommentId = req.ParentId
        };
        _db.Comments.Add(comment);
        await _db.SaveChangesAsync();

        var dto = new
        {
            comment.Id,
            comment.Content,
            userName = user.DisplayName,
            avatarUrl = user.AvatarUrl,
            comment.CreatedAt,
            parentCommentId = comment.ParentCommentId,
            reactions = new List<object>(),
            userReactions = new List<string>()
        };

        await _hub.Clients.Group(mangaId.ToString()).SendAsync("NewComment", dto);

        // Notify @mentioned users. Mentions arrive as "@[Name](userId)" tokens; we
        // trust only the ids, not the names, and skip self + the parent author
        // (they already get a reply notification below).
        var mentionedIds = ExtractMentionIds(comment.Content);
        if (mentionedIds.Count > 0)
        {
            var parentAuthorId = comment.ParentCommentId != null
                ? (await _db.Comments.Where(x => x.Id == comment.ParentCommentId).Select(x => (Guid?)x.UserId).FirstOrDefaultAsync())
                : null;
            var validIds = await _db.Users
                .Where(u => mentionedIds.Contains(u.Id) && u.Id != userId && !u.IsDisabled)
                .Select(u => u.Id)
                .ToListAsync();
            var preview = comment.Content.Length > 80 ? comment.Content[..80] + "..." : comment.Content;
            foreach (var mid in validIds)
            {
                if (mid == parentAuthorId) continue; // reply notification covers this
                _db.Notifications.Add(new Notification
                {
                    UserId = mid,
                    Type = "comment_mention",
                    Title = $"{user.DisplayName} đã nhắc đến bạn",
                    Message = preview,
                    Link = $"/manga/{mangaId}"
                });
            }
            if (validIds.Count > 0) await _db.SaveChangesAsync();
        }

        // Notify parent comment author on reply (skip if replying to own comment)
        if (comment.ParentCommentId != null)
        {
            var parentComment = await _db.Comments.FindAsync(comment.ParentCommentId);
            if (parentComment != null && parentComment.UserId != userId)
            {
                var contentPreview = comment.Content.Length > 80
                    ? comment.Content[..80] + "..."
                    : comment.Content;

                _db.Notifications.Add(new Notification
                {
                    UserId = parentComment.UserId,
                    Type = "comment_reply",
                    Title = $"{user.DisplayName} đã trả lời bình luận của bạn",
                    Message = contentPreview,
                    Link = $"/manga/{mangaId}"
                });
                await _db.SaveChangesAsync();
            }
        }
        // Also notify manga owner (all commenters) about new comments on their favorite manga
        else
        {
            // Notify users who favorited this manga about new comment (except commenter)
            var favoritedUsers = await _db.Favorites
                .Where(f => f.MangaId == mangaId && f.UserId != userId)
                .Select(f => f.UserId)
                .ToListAsync();

            foreach (var favUserId in favoritedUsers)
            {
                _db.Notifications.Add(new Notification
                {
                    UserId = favUserId,
                    Type = "new_comment",
                    Title = $"{user.DisplayName} đã bình luận",
                    Message = comment.Content.Length > 80 ? comment.Content[..80] + "..." : comment.Content,
                    Link = $"/manga/{mangaId}"
                });
            }
            if (favoritedUsers.Count > 0) await _db.SaveChangesAsync();
        }

        return Ok(dto);
    }

    // Pull the user ids out of "@[Name](guid)" mention tokens. Ignores the display
    // name entirely — only the id is trusted for who to notify.
    private static List<Guid> ExtractMentionIds(string content)
    {
        var ids = new List<Guid>();
        foreach (System.Text.RegularExpressions.Match m in
            System.Text.RegularExpressions.Regex.Matches(content, @"@\[[^\]]+\]\(([0-9a-fA-F-]{36})\)"))
        {
            if (Guid.TryParse(m.Groups[1].Value, out var id) && !ids.Contains(id)) ids.Add(id);
        }
        return ids;
    }
}

[ApiController]
[Route("api/comments/{commentId:guid}/reactions")]
[Authorize]
[RequireApproved]
public class CommentReactionsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IHubContext<CommentHub> _hub;

    public CommentReactionsController(AppDbContext db, IHubContext<CommentHub> hub)
    {
        _db = db;
        _hub = hub;
    }

    [HttpPost]
    public async Task<IActionResult> ToggleReaction(Guid commentId, [FromBody] ReactionRequest req)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var user = await _db.Users.FindAsync(userId);

        var existing = await _db.CommentReactions
            .FirstOrDefaultAsync(r => r.CommentId == commentId && r.UserId == userId && r.Type == req.Type);

        bool added;
        if (existing != null)
        {
            _db.CommentReactions.Remove(existing);
            added = false;
        }
        else
        {
            _db.CommentReactions.Add(new CommentReaction
            {
                CommentId = commentId,
                UserId = userId,
                Type = req.Type
            });
            added = true;
        }
        await _db.SaveChangesAsync();

        // Get updated reaction counts
        var reactions = await _db.CommentReactions
            .Where(r => r.CommentId == commentId)
            .GroupBy(r => r.Type)
            .Select(g => new { type = g.Key, count = g.Count() })
            .ToListAsync();

        var comment = await _db.Comments.FindAsync(commentId);
        if (comment != null)
        {
            await _hub.Clients.Group(comment.MangaId.ToString()).SendAsync("ReactionUpdated", new
            {
                commentId,
                reactions,
                userId,
                type = req.Type,
                added
            });

            // Notify comment author on reaction (only when adding, not removing)
            if (added && comment.UserId != userId && user != null)
            {
                _db.Notifications.Add(new Notification
                {
                    UserId = comment.UserId,
                    Type = "comment_reaction",
                    Title = $"{user.DisplayName} đã {req.Type} bình luận của bạn",
                    Message = comment.Content.Length > 80 ? comment.Content[..80] + "..." : comment.Content,
                    Link = $"/manga/{comment.MangaId}"
                });
                await _db.SaveChangesAsync();
            }
        }

        return Ok(new { added, reactions });
    }
}

// Request DTOs
public record CreateCommentRequest(string Content, Guid? ParentId = null);
public record ReactionRequest(string Type);

file static class CommentMapperHelper
{
    public static object MapToDto(Comment c, Guid currentUserId)
    {
        return new
        {
            c.Id,
            c.Content,
            userName = c.User.DisplayName,
            avatarUrl = c.User.AvatarUrl,
            c.CreatedAt,
            parentCommentId = c.ParentCommentId,
            reactions = c.Reactions
                .GroupBy(r => r.Type)
                .Select(g => new { type = g.Key, count = g.Count() })
                .ToList(),
            userReactions = c.Reactions
                .Where(r => r.UserId == currentUserId)
                .Select(r => r.Type)
                .ToList()
        };
    }
}
