using System.Text.Json;
using MangaDrive.Api.Filters;
using MangaDrive.Core.Interfaces;
using MangaDrive.Infrastructure.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace MangaDrive.Api.Controllers;

[ApiController]
[Route("api/admin/metadata")]
[Authorize]
[RequireAdmin]
public class AdminMetadataController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IMetadataService _metadata;

    public AdminMetadataController(AppDbContext db, IMetadataService metadata)
    {
        _db = db;
        _metadata = metadata;
    }

    /// <summary>Search an external source ("anilist" | "mangadex") for metadata candidates.</summary>
    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string source, [FromQuery] string q, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(q)) return BadRequest(new { message = "Thiếu từ khóa tìm kiếm" });
        if (source != "anilist" && source != "mangadex")
            return BadRequest(new { message = "Nguồn không hợp lệ" });

        var candidates = await _metadata.SearchAsync(source, q.Trim(), ct);
        return Ok(candidates);
    }

    /// <summary>Apply a chosen metadata candidate to a manga. Only fields present are overwritten.</summary>
    [HttpPost("apply/{mangaId:guid}")]
    public async Task<IActionResult> Apply(Guid mangaId, [FromBody] ApplyMetadataDto dto)
    {
        var manga = await _db.Mangas.FindAsync(mangaId);
        if (manga == null) return NotFound();

        var opts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        if (dto.ApplyTitle && !string.IsNullOrWhiteSpace(dto.Title))
            manga.Title = dto.Title.Trim();

        if (dto.ApplyOtherTitles && dto.OtherTitles != null)
            manga.OtherTitles = JsonSerializer.Serialize(dto.OtherTitles, opts);

        if (dto.ApplyDescription && dto.Description != null)
            manga.Description = dto.Description;

        if (dto.ApplyAuthor && !string.IsNullOrWhiteSpace(dto.Author))
            manga.Author = dto.Author.Trim();

        if (dto.ApplyStatus && !string.IsNullOrWhiteSpace(dto.Status))
            manga.Status = dto.Status.Trim();

        if (dto.ApplyGenres && dto.Genres != null)
            manga.Genres = JsonSerializer.Serialize(dto.Genres, opts);

        // External image URLs are stored directly; the frontend serves absolute URLs as-is.
        if (dto.ApplyCover && !string.IsNullOrWhiteSpace(dto.CoverUrl))
            manga.CoverImageFileId = dto.CoverUrl.Trim();

        if (dto.ApplyBanner && !string.IsNullOrWhiteSpace(dto.BannerUrl))
            manga.BannerImageFileId = dto.BannerUrl.Trim();

        manga.UpdatedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return Ok(new { manga.Id });
    }
}

public record MetadataTitleDto(string Lang, string Title);

public record ApplyMetadataDto(
    string? Title,
    List<MetadataTitleDto>? OtherTitles,
    string? Description,
    string? Author,
    string? Status,
    List<string>? Genres,
    string? CoverUrl,
    string? BannerUrl,
    bool ApplyTitle = true,
    bool ApplyOtherTitles = true,
    bool ApplyDescription = true,
    bool ApplyAuthor = true,
    bool ApplyStatus = true,
    bool ApplyGenres = true,
    bool ApplyCover = true,
    bool ApplyBanner = true
);
