using System.Text.RegularExpressions;
using MangaDrive.Api.Filters;
using MangaDrive.Api.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace MangaDrive.Api.Controllers;

public record DeriveChapterKeyRequest(string Slug);

[ApiController]
[Route("api/admin/scramble")]
[Authorize]
[RequireAdmin]
public partial class AdminScrambleController : ControllerBase
{
    private static readonly Regex SlugPattern = new(@"^(?:chapter-)?[0-9a-f]{12}$", RegexOptions.Compiled);
    private readonly IConfiguration _config;

    public AdminScrambleController(IConfiguration config) => _config = config;

    [HttpPost("derive-key")]
    public IActionResult DeriveKey([FromBody] DeriveChapterKeyRequest request)
    {
        if (request.Slug is not { Length: <= 20 } slug || !SlugPattern.IsMatch(slug))
            return BadRequest(new { message = "Slug không hợp lệ." });

        var masterKey = _config["Scramble:MasterKey"];
        if (string.IsNullOrEmpty(masterKey))
            return StatusCode(500, new { code = "SERVER_KEY_MISSING", message = "Máy chủ chưa cấu hình khóa giải mã." });

        Response.Headers.CacheControl = "no-store";
        return Ok(new { key = ChapterKeyDeriver.Derive(masterKey, slug) });
    }
}
