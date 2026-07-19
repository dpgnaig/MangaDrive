using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using MangaDrive.Core.DTOs;
using MangaDrive.Core.Entities;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _http;

    public AuthController(AppDbContext db, IConfiguration config, IHttpClientFactory http)
    {
        _db = db;
        _config = config;
        _http = http;
    }

    [HttpPost("google-login")]
    public async Task<ActionResult<AuthResponse>> GoogleLogin([FromBody] GoogleLoginRequest request)
    {
        var client = _http.CreateClient();

        // Đổi authorization code lấy access_token
        var tokenResponse = await client.PostAsync("https://oauth2.googleapis.com/token",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["code"] = request.Code,
                ["client_id"] = _config["Google:ClientId"]!,
                ["client_secret"] = _config["Google:ClientSecret"]!,
                ["redirect_uri"] = request.RedirectUri,
                ["grant_type"] = "authorization_code"
            }));

        if (!tokenResponse.IsSuccessStatusCode)
            return Unauthorized("Invalid authorization code");

        var tokenData = await tokenResponse.Content.ReadFromJsonAsync<GoogleTokenResponse>();

        // Dùng access_token lấy user info
        var userInfoRes = await client.GetAsync(
            $"https://www.googleapis.com/oauth2/v3/userinfo?access_token={tokenData!.AccessToken}");
        if (!userInfoRes.IsSuccessStatusCode)
            return Unauthorized("Cannot get user info");

        var userInfo = await userInfoRes.Content.ReadFromJsonAsync<GoogleUserInfo>();
        if (userInfo?.Sub == null) return Unauthorized();

        var user = await _db.Users.FirstOrDefaultAsync(u => u.GoogleId == userInfo.Sub);
        var adminEmails = _config.GetSection("AdminEmails").Get<string[]>() ?? [];
        var isAdmin = adminEmails.Contains(userInfo.Email, StringComparer.OrdinalIgnoreCase);

        if (user == null)
        {
            user = new AppUser
            {
                GoogleId = userInfo.Sub,
                Email = userInfo.Email ?? string.Empty,
                DisplayName = userInfo.Name ?? userInfo.Email ?? string.Empty,
                AvatarUrl = userInfo.Picture ?? string.Empty,
                Role = isAdmin ? UserRole.Admin : UserRole.User,
                IsApproved = true // Auto-approve all new accounts; admin only disables/removes
            };
            _db.Users.Add(user);
            await _db.SaveChangesAsync();
        }
        else if (isAdmin && user.Role != UserRole.Admin)
        {
            user.Role = UserRole.Admin;
            user.IsApproved = true;
            await _db.SaveChangesAsync();
        }

        // Always sync profile from Google on login
        if (user != null)
        {
            var changed = false;
            var newAvatar = userInfo.Picture ?? string.Empty;
            if (user.AvatarUrl != newAvatar)
            {
                user.AvatarUrl = newAvatar;
                changed = true;
            }
            if (!string.IsNullOrEmpty(userInfo.Email) && user.Email != userInfo.Email)
            {
                user.Email = userInfo.Email;
                changed = true;
            }
            if (changed) await _db.SaveChangesAsync();
        }

        var token = await IssueTokensAsync(user!);
        return Ok(new AuthResponse(token, ToDto(user!)));
    }

    /// <summary>
    /// Exchange a valid refresh cookie for a new access token, rotating the refresh
    /// token. Detects reuse of an already-rotated token and revokes the whole chain.
    /// </summary>
    [HttpPost("refresh")]
    public async Task<ActionResult<AuthResponse>> Refresh()
    {
        var raw = Request.Cookies["refresh_token"];
        if (string.IsNullOrEmpty(raw)) return Unauthorized();

        var hash = HashToken(raw);
        var stored = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash);
        if (stored == null) return Unauthorized();

        // Reuse detection: a token that exists but is already revoked means someone
        // replayed a rotated token — revoke every active token for that user.
        if (!stored.IsActive)
        {
            var active = await _db.RefreshTokens
                .Where(t => t.UserId == stored.UserId && t.RevokedAt == null)
                .ToListAsync();
            foreach (var t in active) t.RevokedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
            ClearAuthCookies();
            return Unauthorized();
        }

        var user = await _db.Users.FindAsync(stored.UserId);
        if (user == null || user.IsDisabled)
        {
            stored.RevokedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
            ClearAuthCookies();
            return Unauthorized();
        }

        // Rotate: revoke the used token and issue a fresh pair.
        stored.RevokedAt = DateTime.UtcNow;
        var token = await IssueTokensAsync(user, replacing: stored);
        return Ok(new AuthResponse(token, ToDto(user)));
    }

    /// <summary>Revoke the current refresh token and clear all auth cookies.</summary>
    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        var raw = Request.Cookies["refresh_token"];
        if (!string.IsNullOrEmpty(raw))
        {
            var hash = HashToken(raw);
            var stored = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash);
            if (stored != null && stored.RevokedAt == null)
            {
                stored.RevokedAt = DateTime.UtcNow;
                await _db.SaveChangesAsync();
            }
        }
        ClearAuthCookies();
        return NoContent();
    }

    private bool SecureCookie => _config.GetValue<bool?>("Cookies:Secure") ?? true;

    /// <summary>
    /// Issue a short-lived access token + a rotated refresh token, and (re)set the
    /// img/hub/refresh cookies. When <paramref name="replacing"/> is set, links the new
    /// refresh token back to the rotated one for reuse detection.
    /// </summary>
    private async Task<string> IssueTokensAsync(AppUser user, RefreshToken? replacing = null)
    {
        var accessToken = GenerateJwt(user);

        // Raw refresh token: cryptographically random, only ever stored hashed.
        var rawRefresh = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(48));
        var refreshHash = HashToken(rawRefresh);
        var refreshDays = int.TryParse(_config["Jwt:RefreshTokenDays"], out var d) ? d : 30;

        _db.RefreshTokens.Add(new RefreshToken
        {
            UserId = user.Id,
            TokenHash = refreshHash,
            ExpiresAt = DateTime.UtcNow.AddDays(refreshDays),
        });
        if (replacing != null) replacing.ReplacedByTokenHash = refreshHash;
        await _db.SaveChangesAsync();

        var secure = SecureCookie;
        // Access-token cookies for image + SignalR auth. They carry the short-lived
        // access token; the frontend proactively refreshes so images keep loading.
        var accessMinutes = int.TryParse(_config["Jwt:AccessTokenMinutes"], out var m) ? m : 60;
        var accessCookie = new CookieOptions
        {
            HttpOnly = true, SameSite = SameSiteMode.Strict, Secure = secure,
            Expires = DateTimeOffset.UtcNow.AddMinutes(accessMinutes),
        };
        Response.Cookies.Append("img_token", accessToken, new CookieOptions
        {
            HttpOnly = accessCookie.HttpOnly, SameSite = accessCookie.SameSite,
            Secure = secure, Path = "/api/images", Expires = accessCookie.Expires,
        });
        Response.Cookies.Append("hub_token", accessToken, new CookieOptions
        {
            HttpOnly = accessCookie.HttpOnly, SameSite = accessCookie.SameSite,
            Secure = secure, Path = "/hubs", Expires = accessCookie.Expires,
        });
        // Refresh cookie scoped to /api/auth so it's only sent to refresh/logout.
        Response.Cookies.Append("refresh_token", rawRefresh, new CookieOptions
        {
            HttpOnly = true, SameSite = SameSiteMode.Strict, Secure = secure,
            Path = "/api/auth", Expires = DateTimeOffset.UtcNow.AddDays(refreshDays),
        });

        return accessToken;
    }

    private void ClearAuthCookies()
    {
        var secure = SecureCookie;
        Response.Cookies.Delete("img_token", new CookieOptions { Path = "/api/images", Secure = secure, SameSite = SameSiteMode.Strict });
        Response.Cookies.Delete("hub_token", new CookieOptions { Path = "/hubs", Secure = secure, SameSite = SameSiteMode.Strict });
        Response.Cookies.Delete("refresh_token", new CookieOptions { Path = "/api/auth", Secure = secure, SameSite = SameSiteMode.Strict });
    }

    private static string HashToken(string raw)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        return Convert.ToHexString(bytes);
    }

    [Authorize]
    [HttpGet("me")]
    public async Task<ActionResult<UserDto>> Me()
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var user = await _db.Users.FindAsync(userId);
        return user == null ? NotFound() : Ok(ToDto(user));
    }

    [HttpPost("complete-profile")]
    [Authorize]
    public async Task<IActionResult> CompleteProfile([FromBody] CompleteProfileRequest req)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var user = await _db.Users.FindAsync(userId);
        if (user == null) return NotFound();
        if (user.IsProfileCompleted) return BadRequest("Profile already completed");

        if (!string.IsNullOrWhiteSpace(req.DisplayName) && !user.HasChangedName)
        {
            user.DisplayName = req.DisplayName.Trim();
            user.HasChangedName = true;
        }
        if (req.Birthday != null) user.Birthday = req.Birthday;
        user.IsProfileCompleted = true;
        await _db.SaveChangesAsync();

        return Ok(ToDto(user));
    }

    private string GenerateJwt(AppUser user)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_config["Jwt:Secret"]!));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            issuer: _config["Jwt:Issuer"],
            audience: _config["Jwt:Audience"],
            claims: new[]
            {
                new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
                new Claim(ClaimTypes.Email, user.Email),
                new Claim(ClaimTypes.Role, user.Role.ToString())
            },
            expires: DateTime.UtcNow.AddMinutes(int.TryParse(_config["Jwt:AccessTokenMinutes"], out var m) ? m : 60),
            signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static UserDto ToDto(AppUser u) =>
        new(u.Id, u.Email, u.DisplayName, u.AvatarUrl, u.Role, u.IsApproved, u.IsDisabled, u.IsProfileCompleted, u.HasChangedName);

    private record GoogleTokenResponse(
        [property: System.Text.Json.Serialization.JsonPropertyName("access_token")] string? AccessToken,
        [property: System.Text.Json.Serialization.JsonPropertyName("token_type")] string? TokenType,
        [property: System.Text.Json.Serialization.JsonPropertyName("expires_in")] int? ExpiresIn);
    private record GoogleUserInfo(
        [property: System.Text.Json.Serialization.JsonPropertyName("sub")] string? Sub,
        [property: System.Text.Json.Serialization.JsonPropertyName("email")] string? Email,
        [property: System.Text.Json.Serialization.JsonPropertyName("name")] string? Name,
        [property: System.Text.Json.Serialization.JsonPropertyName("picture")] string? Picture);
}

public record CompleteProfileRequest(string? DisplayName, DateTime? Birthday);
