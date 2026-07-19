using System.Security.Claims;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace MangaDrive.Api.Filters;

public class RequireAdminAttribute : TypeFilterAttribute
{
    public RequireAdminAttribute() : base(typeof(RequireAdminFilter)) { }
}

/// <summary>
/// Authorizes admins by re-reading the role from the DB rather than trusting the
/// JWT role claim. This makes a demote (or disable) take effect immediately instead
/// of lingering until the 7-day token expires.
/// </summary>
public class RequireAdminFilter : IAsyncActionFilter
{
    private readonly AppDbContext _db;

    public RequireAdminFilter(AppDbContext db) => _db = db;

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var userIdClaim = context.HttpContext.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userIdClaim == null)
        {
            context.Result = new UnauthorizedResult();
            return;
        }

        var user = await _db.Users.FindAsync(Guid.Parse(userIdClaim));
        if (user == null || user.IsDisabled || user.Role != UserRole.Admin)
        {
            context.Result = new ForbidResult();
            return;
        }

        await next();
    }
}
