using MangaDrive.Core.Entities;
using Microsoft.EntityFrameworkCore;

namespace MangaDrive.Infrastructure.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<MangaRootFolder> RootFolders => Set<MangaRootFolder>();
    public DbSet<Manga> Mangas => Set<Manga>();
    public DbSet<Chapter> Chapters => Set<Chapter>();
    public DbSet<ChapterImage> ChapterImages => Set<ChapterImage>();
    public DbSet<UserRootFolderPermission> UserRootFolderPermissions => Set<UserRootFolderPermission>();
    public DbSet<UserMangaPermission> UserMangaPermissions => Set<UserMangaPermission>();
    public DbSet<SyncJob> SyncJobs => Set<SyncJob>();
    public DbSet<SyncJobLog> SyncJobLogs => Set<SyncJobLog>();
    public DbSet<Comment> Comments => Set<Comment>();
    public DbSet<CommentReaction> CommentReactions => Set<CommentReaction>();
    public DbSet<Favorite> Favorites => Set<Favorite>();
    public DbSet<ReadingHistory> ReadingHistories => Set<ReadingHistory>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<MangaRequest> MangaRequests => Set<MangaRequest>();
    public DbSet<RequestConversation> RequestConversations => Set<RequestConversation>();
    public DbSet<RequestMessage> RequestMessages => Set<RequestMessage>();
    public DbSet<DmConversation> DmConversations => Set<DmConversation>();
    public DbSet<DmMessage> DmMessages => Set<DmMessage>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<Setting> Settings => Set<Setting>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AppUser>().HasIndex(u => u.GoogleId).IsUnique();
        modelBuilder.Entity<AppUser>().HasIndex(u => u.Email).IsUnique();
        // Persist Role as its string name ("User"/"Admin") so the existing TEXT column,
        // the JWT role claim, and [Authorize(Roles = "Admin")] all match on the same literals.
        modelBuilder.Entity<AppUser>().Property(u => u.Role).HasConversion<string>().HasMaxLength(16);

        modelBuilder.Entity<Manga>()
            .HasOne(m => m.RootFolder)
            .WithMany(r => r.Mangas)
            .HasForeignKey(m => m.RootFolderId);

        modelBuilder.Entity<Manga>().HasIndex(m => m.DriveFileId).IsUnique();

        modelBuilder.Entity<Chapter>()
            .HasOne(c => c.Manga)
            .WithMany(m => m.Chapters)
            .HasForeignKey(c => c.MangaId);

        modelBuilder.Entity<ChapterImage>()
            .HasOne(ci => ci.Chapter)
            .WithMany(c => c.Images)
            .HasForeignKey(ci => ci.ChapterId);

        modelBuilder.Entity<UserRootFolderPermission>()
            .HasIndex(p => new { p.UserId, p.RootFolderId }).IsUnique();

        modelBuilder.Entity<UserMangaPermission>()
            .HasIndex(p => new { p.UserId, p.MangaId }).IsUnique();

        modelBuilder.Entity<SyncJob>()
            .HasOne(s => s.RootFolder)
            .WithMany()
            .HasForeignKey(s => s.RootFolderId);

        modelBuilder.Entity<SyncJobLog>()
            .HasOne(l => l.SyncJob)
            .WithMany(s => s.Logs)
            .HasForeignKey(l => l.SyncJobId);

        modelBuilder.Entity<Comment>()
            .HasOne(c => c.Manga)
            .WithMany(m => m.Comments)
            .HasForeignKey(c => c.MangaId);

        modelBuilder.Entity<Comment>()
            .HasOne(c => c.User)
            .WithMany()
            .HasForeignKey(c => c.UserId);

        modelBuilder.Entity<Comment>()
            .HasOne(c => c.ParentComment)
            .WithMany(c => c.Replies)
            .HasForeignKey(c => c.ParentCommentId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<CommentReaction>()
            .HasOne(r => r.Comment)
            .WithMany(c => c.Reactions)
            .HasForeignKey(r => r.CommentId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<CommentReaction>()
            .HasOne(r => r.User)
            .WithMany()
            .HasForeignKey(r => r.UserId);

        modelBuilder.Entity<CommentReaction>()
            .HasIndex(r => new { r.CommentId, r.UserId, r.Type }).IsUnique();

        modelBuilder.Entity<Favorite>()
            .HasIndex(f => new { f.UserId, f.MangaId }).IsUnique();

        modelBuilder.Entity<ReadingHistory>()
            .HasIndex(r => new { r.UserId, r.MangaId }).IsUnique();

        modelBuilder.Entity<Notification>()
            .ToTable("Notifications", t => t.ExcludeFromMigrations());

        modelBuilder.Entity<Notification>()
            .HasOne(n => n.User)
            .WithMany()
            .HasForeignKey(n => n.UserId);

        modelBuilder.Entity<Notification>()
            .HasIndex(n => new { n.UserId, n.IsRead });

        modelBuilder.Entity<MangaRequest>()
            .HasOne(r => r.User)
            .WithMany()
            .HasForeignKey(r => r.UserId);

        modelBuilder.Entity<MangaRequest>()
            .HasIndex(r => r.Status);

        modelBuilder.Entity<Setting>()
            .ToTable("Settings", t => t.ExcludeFromMigrations());
        modelBuilder.Entity<Setting>().HasKey(s => s.Key);

        modelBuilder.Entity<RequestConversation>()
            .ToTable("RequestConversations", t => t.ExcludeFromMigrations());
        modelBuilder.Entity<RequestConversation>()
            .HasOne(c => c.User)
            .WithMany()
            .HasForeignKey(c => c.UserId);
        modelBuilder.Entity<RequestConversation>()
            .HasIndex(c => c.UserId).IsUnique();

        modelBuilder.Entity<RequestMessage>()
            .ToTable("RequestMessages", t => t.ExcludeFromMigrations());
        modelBuilder.Entity<RequestMessage>()
            .HasOne(m => m.Conversation)
            .WithMany()
            .HasForeignKey(m => m.ConversationId);
        modelBuilder.Entity<RequestMessage>()
            .HasIndex(m => m.ConversationId);

        modelBuilder.Entity<DmConversation>()
            .ToTable("DmConversations", t => t.ExcludeFromMigrations());
        modelBuilder.Entity<DmConversation>()
            .HasOne(c => c.User1)
            .WithMany()
            .HasForeignKey(c => c.User1Id)
            .OnDelete(DeleteBehavior.Restrict);
        modelBuilder.Entity<DmConversation>()
            .HasOne(c => c.User2)
            .WithMany()
            .HasForeignKey(c => c.User2Id)
            .OnDelete(DeleteBehavior.Restrict);
        modelBuilder.Entity<DmConversation>()
            .HasIndex(c => new { c.User1Id, c.User2Id }).IsUnique();

        modelBuilder.Entity<DmMessage>()
            .ToTable("DmMessages", t => t.ExcludeFromMigrations());
        modelBuilder.Entity<DmMessage>()
            .HasOne(m => m.Conversation)
            .WithMany()
            .HasForeignKey(m => m.ConversationId);
        modelBuilder.Entity<DmMessage>()
            .HasIndex(m => m.ConversationId);

        modelBuilder.Entity<RefreshToken>()
            .ToTable("RefreshTokens", t => t.ExcludeFromMigrations());
        modelBuilder.Entity<RefreshToken>()
            .HasOne(t => t.User)
            .WithMany()
            .HasForeignKey(t => t.UserId)
            .OnDelete(DeleteBehavior.Cascade);
        modelBuilder.Entity<RefreshToken>()
            .HasIndex(t => t.TokenHash).IsUnique();
    }
}
