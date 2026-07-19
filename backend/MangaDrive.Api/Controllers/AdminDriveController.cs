using MangaDrive.Api.Filters;
using MangaDrive.Core.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/admin/drive")]
[Authorize]
[RequireAdmin]
public class AdminDriveController : ControllerBase
{
    private readonly IGoogleDriveService _drive;

    public AdminDriveController(IGoogleDriveService drive) => _drive = drive;

    [HttpGet("shared-folders")]
    public async Task<IActionResult> GetSharedFolders()
    {
        var folders = await _drive.ListSharedFoldersAsync();
        return Ok(folders);
    }

    // The service account email. The admin shares their upload folder with this
    // address so the (readonly) service account can serve the images via /api/images.
    [HttpGet("service-account")]
    public IActionResult GetServiceAccount()
    {
        return Ok(new { email = _drive.ServiceAccountEmail });
    }
}
