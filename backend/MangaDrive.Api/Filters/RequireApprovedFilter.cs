using System.Security.Claims;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace MangaDrive.Api.Filters;

public class RequireApprovedAttribute : TypeFilterAttribute
{
    public RequireApprovedAttribute() : base(typeof(RequireApprovedFilter)) { }
}

public class RequireApprovedFilter : IAsyncActionFilter
{
    private readonly AppDbContext _db;

    public RequireApprovedFilter(AppDbContext db) => _db = db;

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var userIdClaim = context.HttpContext.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userIdClaim == null)
        {
            context.Result = new UnauthorizedResult();
            return;
        }

        var userId = Guid.Parse(userIdClaim);
        var user = await _db.Users.FindAsync(userId);

        if (user == null)
        {
            context.Result = new UnauthorizedResult();
            return;
        }

        // Disabled applies to everyone, admins included — check it before the admin
        // bypass so a disabled admin can't keep using user-facing endpoints.
        if (user.IsDisabled)
        {
            context.Result = new ObjectResult(new { message = "Tài khoản đã bị vô hiệu hóa." })
            {
                StatusCode = 403
            };
            return;
        }

        if (user.Role == UserRole.Admin)
        {
            await next();
            return;
        }

        if (!user.IsApproved)
        {
            context.Result = new ObjectResult(new { message = "Tài khoản chưa được admin phê duyệt. Vui lòng chờ." })
            {
                StatusCode = 403
            };
            return;
        }

        await next();
    }
}
