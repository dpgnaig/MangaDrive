using System.Text;
using MangaDrive.Api.Hubs;
using MangaDrive.Api.Services;
using MangaDrive.Core.Interfaces;
using MangaDrive.Infrastructure.Data;
using MangaDrive.Infrastructure.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlite(builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidAudience = builder.Configuration["Jwt:Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(
                Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!))
        };
        o.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var path = context.HttpContext.Request.Path;

                // SignalR: prefer the standard access_token query param (reliable
                // over WebSockets, incl. iOS Safari where the browser does not attach
                // cookies to the WS handshake). Fall back to the HttpOnly hub_token cookie.
                if (path.StartsWithSegments("/hubs"))
                {
                    var accessToken = context.Request.Query["access_token"];
                    if (!string.IsNullOrEmpty(accessToken))
                        context.Token = accessToken;
                    else
                    {
                        var cookie = context.Request.Cookies["hub_token"];
                        if (!string.IsNullOrEmpty(cookie))
                            context.Token = cookie;
                    }
                }

                // Images: read from HttpOnly cookie
                if (path.StartsWithSegments("/api/images"))
                {
                    var cookie = context.Request.Cookies["img_token"];
                    if (!string.IsNullOrEmpty(cookie))
                        context.Token = cookie;
                }

                return Task.CompletedTask;
            }
        };
    });

builder.Services.AddAuthorization();

// Per-user rate limit for the scramble-key endpoint: throttles bulk enumeration of
// per-chapter keys while leaving normal sequential reading unaffected. Partitioned
// on the authenticated user id (falls back to remote IP for unauthenticated calls).
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("scramble-key", httpContext =>
    {
        var partitionKey = httpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
            ?? httpContext.Connection.RemoteIpAddress?.ToString()
            ?? "anonymous";
        return System.Threading.RateLimiting.RateLimitPartition.GetFixedWindowLimiter(
            partitionKey,
            _ => new System.Threading.RateLimiting.FixedWindowRateLimiterOptions
            {
                PermitLimit = 20,
                Window = TimeSpan.FromSeconds(10),
                QueueLimit = 0
            });
    });
});

builder.Services.AddControllers()
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        // Serialize UserRole (and any enum) as its string name ("Admin"/"User"), matching
        // what the frontend and JWT role claim expect — not the underlying integer.
        o.JsonSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
    });
builder.Services.AddSignalR()
    // Match the MVC camelCase policy so hub payloads use the same field casing
    // (senderId, id, ...) that REST responses and the frontend expect. Without this
    // SignalR serializes PascalCase, so realtime messages lose senderId/id.
    .AddJsonProtocol(o =>
    {
        o.PayloadSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        o.PayloadSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
    });
// TLS validation is ON by default. Only disable it when Http:InsecureTls is set —
// needed when developing behind a corporate MITM proxy with a self-signed cert.
// NEVER enable this in production: this same client sends the OAuth client_secret
// to Google, so skipping cert validation exposes it to a man-in-the-middle.
var insecureTls = builder.Configuration.GetValue<bool>("Http:InsecureTls");
builder.Services.AddHttpClient(string.Empty)
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
    {
        ServerCertificateCustomValidationCallback = insecureTls
            ? HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
            : null
    });

builder.Services.AddScoped<IGoogleDriveService, GoogleDriveService>();
builder.Services.AddScoped<IMangaSyncService, MangaSyncService>();
builder.Services.AddScoped<IMetadataService, MetadataService>();
builder.Services.AddScoped<ISyncNotifier, SyncNotifier>();
builder.Services.AddHostedService<SyncBackgroundService>();
builder.Services.AddHostedService<AutoSyncService>();

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()!)
     .AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();

    // Create Notifications table if not exists (added outside EF migrations)
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS Notifications (
            Id TEXT NOT NULL PRIMARY KEY,
            UserId TEXT NOT NULL,
            Type TEXT NOT NULL,
            Title TEXT NOT NULL,
            Message TEXT NOT NULL,
            Link TEXT,
            IsRead INTEGER NOT NULL DEFAULT 0,
            CreatedAt TEXT NOT NULL,
            FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
        );
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE INDEX IF NOT EXISTS IX_Notifications_UserId_IsRead ON Notifications(UserId, IsRead);
    ");

    // Create Settings table if not exists (added outside EF migrations)
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS Settings (
            Key TEXT NOT NULL PRIMARY KEY,
            Value TEXT NOT NULL
        );
    ");
    // Seed default announcement if missing
    if (!db.Settings.Any(s => s.Key == "announcement"))
    {
        db.Settings.Add(new MangaDrive.Core.Entities.Setting
        {
            Key = "announcement",
            Value = "Website đang được cập nhật truyện mỗi ngày • Theo dõi để không bỏ lỡ chapter mới nhất! • Chúc bạn đọc truyện vui vẻ ~"
        });
        db.SaveChanges();
    }

    // Auto-approve everyone: registration no longer needs admin approval.
    // Admin only disables/removes accounts now.
    try { db.Database.ExecuteSqlRaw("UPDATE Users SET IsApproved = 1 WHERE IsApproved = 0"); } catch { }

    // Create RequestConversations / RequestMessages tables (added outside EF migrations)
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS RequestConversations (
            Id TEXT NOT NULL PRIMARY KEY,
            UserId TEXT NOT NULL,
            Status TEXT NOT NULL DEFAULT 'Open',
            CreatedAt TEXT NOT NULL,
            LastMessageAt TEXT NOT NULL,
            LastMessagePreview TEXT,
            MemberUnread INTEGER NOT NULL DEFAULT 0,
            AdminUnread INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
        );
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE UNIQUE INDEX IF NOT EXISTS IX_RequestConversations_UserId ON RequestConversations(UserId);
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS RequestMessages (
            Id TEXT NOT NULL PRIMARY KEY,
            ConversationId TEXT NOT NULL,
            SenderId TEXT NOT NULL,
            SenderRole TEXT NOT NULL,
            Content TEXT NOT NULL,
            CreatedAt TEXT NOT NULL,
            FOREIGN KEY (ConversationId) REFERENCES RequestConversations(Id) ON DELETE CASCADE
        );
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE INDEX IF NOT EXISTS IX_RequestMessages_ConversationId ON RequestMessages(ConversationId);
    ");
    // Per-message status label (null = normal message); SQLite has no ADD COLUMN IF NOT EXISTS
    try { db.Database.ExecuteSqlRaw("ALTER TABLE RequestMessages ADD COLUMN Status TEXT"); } catch { }

    // Create DM tables (general user-to-user direct messages, added outside EF migrations)
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS DmConversations (
            Id TEXT NOT NULL PRIMARY KEY,
            User1Id TEXT NOT NULL,
            User2Id TEXT NOT NULL,
            CreatedAt TEXT NOT NULL,
            LastMessageAt TEXT NOT NULL,
            LastMessagePreview TEXT,
            User1Unread INTEGER NOT NULL DEFAULT 0,
            User2Unread INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (User1Id) REFERENCES Users(Id) ON DELETE CASCADE,
            FOREIGN KEY (User2Id) REFERENCES Users(Id) ON DELETE CASCADE
        );
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE UNIQUE INDEX IF NOT EXISTS IX_DmConversations_Pair ON DmConversations(User1Id, User2Id);
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS DmMessages (
            Id TEXT NOT NULL PRIMARY KEY,
            ConversationId TEXT NOT NULL,
            SenderId TEXT NOT NULL,
            Type TEXT NOT NULL DEFAULT 'Text',
            Content TEXT NOT NULL,
            Status TEXT,
            CreatedAt TEXT NOT NULL,
            FOREIGN KEY (ConversationId) REFERENCES DmConversations(Id) ON DELETE CASCADE
        );
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE INDEX IF NOT EXISTS IX_DmMessages_ConversationId ON DmMessages(ConversationId);
    ");
    // Per-participant read cursors (added outside EF migrations).
    try { db.Database.ExecuteSqlRaw("ALTER TABLE DmConversations ADD COLUMN User1LastReadAt TEXT"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE DmConversations ADD COLUMN User2LastReadAt TEXT"); } catch { }

    // Refresh tokens (added outside EF migrations). Stored hashed; rotated on each use.
    db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS RefreshTokens (
            Id TEXT NOT NULL PRIMARY KEY,
            UserId TEXT NOT NULL,
            TokenHash TEXT NOT NULL,
            ExpiresAt TEXT NOT NULL,
            CreatedAt TEXT NOT NULL,
            RevokedAt TEXT,
            ReplacedByTokenHash TEXT,
            FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
        );
    ");
    db.Database.ExecuteSqlRaw(@"
        CREATE UNIQUE INDEX IF NOT EXISTS IX_RefreshTokens_TokenHash ON RefreshTokens(TokenHash);
    ");

    // One-time backfill: convert legacy request conversations into DM conversations with the first admin
    try
    {
        var firstAdmin = db.Users.Where(u => u.Role == MangaDrive.Core.Entities.UserRole.Admin).OrderBy(u => u.CreatedAt).FirstOrDefault();
        if (firstAdmin != null)
        {
            foreach (var rc in db.RequestConversations.ToList())
            {
                if (rc.UserId == firstAdmin.Id) continue; // skip admin's own request convo
                var a = rc.UserId.CompareTo(firstAdmin.Id) < 0 ? rc.UserId : firstAdmin.Id;
                var b = rc.UserId.CompareTo(firstAdmin.Id) < 0 ? firstAdmin.Id : rc.UserId;

                var dm = db.DmConversations.FirstOrDefault(c => c.User1Id == a && c.User2Id == b);
                if (dm == null)
                {
                    dm = new MangaDrive.Core.Entities.DmConversation
                    {
                        User1Id = a,
                        User2Id = b,
                        CreatedAt = rc.CreatedAt,
                        LastMessageAt = rc.LastMessageAt
                    };
                    db.DmConversations.Add(dm);
                    db.SaveChanges();
                }

                if (db.DmMessages.Any(m => m.ConversationId == dm.Id)) continue; // already seeded

                string? lastPreview = null;
                var lastAt = dm.CreatedAt;
                foreach (var rm in db.RequestMessages.Where(m => m.ConversationId == rc.Id).OrderBy(m => m.CreatedAt).ToList())
                {
                    var senderId = rm.SenderRole == "Admin" ? firstAdmin.Id : rc.UserId;
                    db.DmMessages.Add(new MangaDrive.Core.Entities.DmMessage
                    {
                        ConversationId = dm.Id,
                        SenderId = senderId,
                        Type = rm.Status != null ? "Request" : "Text",
                        Content = rm.Content,
                        Status = rm.Status,
                        CreatedAt = rm.CreatedAt
                    });
                    lastPreview = rm.Content.Length > 100 ? rm.Content[..100] : rm.Content;
                    if (rm.CreatedAt > lastAt) lastAt = rm.CreatedAt;
                }
                dm.LastMessagePreview = lastPreview;
                dm.LastMessageAt = lastAt;
                db.SaveChanges();
            }
        }
    }
    catch { /* backfill is best-effort */ }

    // One-time backfill: convert legacy MangaRequests rows into conversation messages
    try
    {
        var legacyRequests = db.MangaRequests.OrderBy(r => r.CreatedAt).ToList();
        if (legacyRequests.Count > 0)
        {
            foreach (var grp in legacyRequests.GroupBy(r => r.UserId))
            {
                var convo = db.RequestConversations.FirstOrDefault(c => c.UserId == grp.Key);
                if (convo == null)
                {
                    convo = new MangaDrive.Core.Entities.RequestConversation
                    {
                        UserId = grp.Key,
                        Status = "Open",
                        CreatedAt = grp.Min(r => r.CreatedAt),
                        LastMessageAt = grp.Min(r => r.CreatedAt)
                    };
                    db.RequestConversations.Add(convo);
                    db.SaveChanges();
                }

                // Only seed if this conversation has no messages yet
                if (db.RequestMessages.Any(m => m.ConversationId == convo.Id)) continue;

                string? lastPreview = null;
                var lastAt = convo.CreatedAt;
                foreach (var r in grp.OrderBy(r => r.CreatedAt))
                {
                    var memberText = r.Title;
                    if (!string.IsNullOrWhiteSpace(r.Description)) memberText += "\n" + r.Description;
                    if (!string.IsNullOrWhiteSpace(r.ReferenceUrl)) memberText += "\n" + r.ReferenceUrl;

                    db.RequestMessages.Add(new MangaDrive.Core.Entities.RequestMessage
                    {
                        ConversationId = convo.Id,
                        SenderId = grp.Key,
                        SenderRole = "Member",
                        Content = memberText,
                        CreatedAt = r.CreatedAt
                    });
                    lastPreview = r.Title;
                    lastAt = r.CreatedAt;

                    if (!string.IsNullOrWhiteSpace(r.AdminNote))
                    {
                        var adminAt = r.RespondedAt ?? r.CreatedAt;
                        db.RequestMessages.Add(new MangaDrive.Core.Entities.RequestMessage
                        {
                            ConversationId = convo.Id,
                            SenderId = grp.Key, // legacy note had no admin id; attribute to conversation
                            SenderRole = "Admin",
                            Content = r.AdminNote!,
                            CreatedAt = adminAt
                        });
                        lastPreview = r.AdminNote;
                        if (adminAt > lastAt) lastAt = adminAt;
                    }

                    // Carry over the most recent non-pending status as the label
                    if (r.Status == "Approved" || r.Status == "Rejected") convo.Status = r.Status;
                }

                convo.LastMessagePreview = lastPreview;
                convo.LastMessageAt = lastAt;
                db.SaveChanges();
            }
        }
    }
    catch { /* backfill is best-effort */ }

    // Add new columns if not exist
    try { db.Database.ExecuteSqlRaw("ALTER TABLE Mangas ADD COLUMN OtherTitles TEXT NOT NULL DEFAULT '[]'"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE Mangas ADD COLUMN BannerImageFileId TEXT NOT NULL DEFAULT ''"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE Mangas ADD COLUMN LinkedMangaId TEXT"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE RootFolders ADD COLUMN IsAutoAdded INTEGER NOT NULL DEFAULT 0"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE Comments ADD COLUMN ParentCommentId TEXT"); } catch { }
    try { db.Database.ExecuteSqlRaw(@"
        CREATE TABLE IF NOT EXISTS CommentReactions (
            Id TEXT PRIMARY KEY,
            CommentId TEXT NOT NULL,
            UserId TEXT NOT NULL,
            Type TEXT NOT NULL,
            CreatedAt TEXT NOT NULL,
            FOREIGN KEY (CommentId) REFERENCES Comments(Id) ON DELETE CASCADE,
            FOREIGN KEY (UserId) REFERENCES Users(Id)
        )"); } catch { }
    try { db.Database.ExecuteSqlRaw("CREATE UNIQUE INDEX IF NOT EXISTS IX_CommentReactions_CommentId_UserId_Type ON CommentReactions (CommentId, UserId, Type)"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE Users ADD COLUMN IsProfileCompleted INTEGER NOT NULL DEFAULT 0"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE Users ADD COLUMN Birthday TEXT"); } catch { }
    try { db.Database.ExecuteSqlRaw("ALTER TABLE Users ADD COLUMN HasChangedName INTEGER NOT NULL DEFAULT 0"); } catch { }

    // Auto-add shared folders from Drive. Any folder registered here must also be
    // queued for sync — otherwise it sits in RootFolders with zero mangas forever:
    // AutoSyncService.DetectNewSharedFolders runs 2 minutes after startup and skips
    // any Drive folder ID already present in RootFolders, so if THIS block is the one
    // that first registers a newly-shared folder (it always runs first, since it's
    // synchronous at startup vs. AutoSyncService's 2-minute delay), nothing else will
    // ever trigger its initial sync.
    try
    {
        var drive = scope.ServiceProvider.GetRequiredService<IGoogleDriveService>();
        var sharedFolders = await drive.ListSharedFoldersAsync();
        var existingIds = db.RootFolders.Select(r => r.GoogleDriveFolderId).ToHashSet();
        var newlyAddedRoots = new List<MangaDrive.Core.Entities.MangaRootFolder>();
        foreach (var sf in sharedFolders)
        {
            if (!existingIds.Contains(sf.Id))
            {
                var newRoot = new MangaDrive.Core.Entities.MangaRootFolder
                {
                    Name = sf.Name,
                    GoogleDriveFolderId = sf.Id,
                    IsPublic = true,
                    IsAutoAdded = true
                };
                db.RootFolders.Add(newRoot);
                newlyAddedRoots.Add(newRoot);
            }
        }
        db.SaveChanges();
        foreach (var newRoot in newlyAddedRoots)
        {
            await SyncBackgroundService.Queue.Writer.WriteAsync(
                new SyncRequest(newRoot.Id, SyncRequestType.RootFolder));
        }
    }
    catch { /* Drive not available at startup - skip */ }

    // Backfill ChapterNumber for existing chapters that don't have it
    var chaptersToFill = db.Chapters.Where(c => c.ChapterNumber == null).ToList();
    if (chaptersToFill.Count > 0)
    {
        foreach (var ch in chaptersToFill)
        {
            var numMatch = System.Text.RegularExpressions.Regex.Match(ch.Name, @"(\d+\.?\d*)");
            if (numMatch.Success) ch.ChapterNumber = numMatch.Groups[1].Value;

            // Extract name after separator
            var separators = new[] { " — ", " – ", " - ", ": " };
            foreach (var sep in separators)
            {
                var idx = ch.Name.IndexOf(sep, StringComparison.Ordinal);
                if (idx >= 0) { var n = ch.Name[(idx + sep.Length)..].Trim(); ch.ChapterName = string.IsNullOrEmpty(n) ? null : n; break; }
            }
        }
        db.SaveChanges();
    }
}

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.MapControllers();
app.MapHub<SyncHub>("/hubs/sync");
app.MapHub<CommentHub>("/hubs/comments");
app.MapHub<RequestsHub>("/hubs/requests");
app.MapHub<ChatHub>("/hubs/chat");

app.Run();
