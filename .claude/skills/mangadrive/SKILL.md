---
name: mangadrive
description: Kiến trúc, quy ước và luồng dữ liệu của MangaDrive — manga reader full-stack (.NET 8 API + React/Vite) đọc truyện trực tiếp từ Google Drive. Đọc skill này TRƯỚC khi sửa backend, frontend, sync, auth, scramble ảnh, hoặc deploy.
---

# MangaDrive

Web đọc manga. Nội dung (ảnh + metadata) nằm trên **Google Drive**, được backend đồng bộ (sync) vào SQLite làm chỉ mục, rồi stream ảnh về client. Không lưu ảnh trên server — ảnh luôn tải on-demand từ Drive qua backend.

## Tech stack

| Phần | Công nghệ |
|------|-----------|
| Backend | .NET 8, ASP.NET Core Web API, EF Core + SQLite, SignalR |
| Frontend | React 19, Vite, TypeScript, React Router 7, Ant Design 6, axios, @microsoft/signalr, swiper |
| Auth | Google OAuth 2.0 (authorization code flow) → JWT |
| Drive | Google Drive API v3 qua Service Account (readonly) |
| Deploy | Docker Compose, Caddy (auto HTTPS/Let's Encrypt), nginx serve SPA, Cloudflare |

## Cấu trúc thư mục

```
backend/
├── MangaDrive.Api/            # Controllers, Hubs, Program.cs, Filters, SyncNotifier
├── MangaDrive.Core/           # Entities, DTOs (DTOs/Dtos.cs), Interfaces — không phụ thuộc gì
└── MangaDrive.Infrastructure/ # AppDbContext, Migrations, Services (Drive/Sync/AutoSync)
frontend/src/
├── context/AuthContext.tsx    # JWT trong localStorage, user state toàn cục
├── lib/                       # api.ts (axios), cache.ts (manga cache 5'), img.ts
├── components/                # TopNav, BottomNav, UnscrambleImage, ImageViewer, Skeleton...
└── pages/  + pages/admin/     # Trang user + trang admin
```

Clean-ish 3 tầng: `Core` (thuần domain, không ref project khác) ← `Infrastructure` (EF, Drive) ← `Api`.

## Luồng Auth (quan trọng)

1. Frontend redirect tới Google OAuth (`response_type=code`), redirect URI = `<origin>/login`.
2. Google trả `code` về `/login?code=...`. Frontend `POST /api/auth/google-login { code, redirectUri }`.
3. Backend (`AuthController`) đổi `code` → `access_token` (dùng ClientId + ClientSecret), gọi userinfo, tạo/cập nhật `AppUser`, trả **JWT**.
4. Frontend lưu JWT vào `localStorage`, gắn `Authorization: Bearer` cho mọi request (interceptor trong `lib/api.ts`).
5. Backend cũng set 2 **HttpOnly cookie** từ cùng JWT: `img_token` (path `/api/images`) và `hub_token` (path `/hubs`). Lý do: `<img>`/`fetch ảnh` và SignalR không gắn header Authorization được → đọc token từ cookie (xem `Program.cs` `OnMessageReceived`).
   - ⚠️ Cookie đang set `Secure = false` (comment ghi "set true in production"). Nếu sửa auth/HTTPS, để ý chỗ này.
6. Admin: email nằm trong config `AdminEmails[]` → tự set `Role=Admin`, `IsApproved=true` khi login. User thường mặc định `IsApproved=false` → phải admin duyệt.

### Gác cổng (authorization)
- `[Authorize]` = có JWT hợp lệ.
- `[Authorize(Roles = "Admin")]` = chỉ admin (mọi controller `api/admin/*`).
- `[RequireApproved]` (filter `RequireApprovedFilter`) = user phải `IsApproved` và không `IsDisabled`; admin bỏ qua. Dùng cho `mangas`, `chapters`, `images`, `comments`, user-data.
- Frontend gác route trong `App.tsx` `ProtectedRoute`: chưa login → `/login`; chưa duyệt → `/pending`; chưa hoàn tất profile (`isProfileCompleted`) → `/onboarding`.

## Mô hình dữ liệu (entities chính)

- **AppUser** — GoogleId, Email, Role (`Admin`/`User`), IsApproved, IsDisabled, IsProfileCompleted, HasChangedName, Birthday.
- **MangaRootFolder** — 1 folder gốc Drive. `IsAutoAdded` (tự thêm từ Shared-with-me, **không cho xóa**), `IsPublic`, `IsActive`, `ChangesPageToken`, `LastSyncedAt`.
- **Manga** — thuộc 1 RootFolder. `DriveFileId` (unique), Title, OtherTitles/Genres = **JSON string**, Cover/BannerImageFileId, `IsHidden`, **`LinkedMangaId`** (xem Linked mangas), `ViewCount`.
- **Chapter** — `DriveFileId`, Name, `ChapterNumber` (vd "5.5"), `ChapterName` (phần sau dấu phân cách), SortOrder.
- **ChapterImage** — DriveFileId, FileName, MimeType, SortOrder.
- **Comment** — có `ParentCommentId` (reply lồng), `Reactions` (CommentReaction, emoji).
- **Favorite**, **ReadingHistory** (unique theo User+Manga), **Notification**, **MangaRequest**, **SyncJob**/**SyncJobLog**, quyền: **UserRootFolderPermission**, **UserMangaPermission**.

### Linked mangas (dễ nhầm)
Nhiều folder Drive có thể là cùng một truyện. Một manga có thể trỏ `LinkedMangaId` tới một **primary**. Quy ước:
- Primary = `LinkedMangaId == null`. Danh sách/ chi tiết **chỉ hiện primary**, chapter của các bản linked được **gộp** vào primary và sắp lại `SortOrder` theo số chương (`ReorderLinkedChapters`).
- Auto-link khi sync: manga mới trùng Title với một primary sẽ tự link.
- Xóa manga/root: nếu xóa primary thì **promote** một bản linked lên làm primary mới (xem `AdminMangasController.Delete`, `AdminRootFoldersController.Delete`).

## Sync — trái tim hệ thống

### Cấu trúc folder trên Drive
```
Root (share cho Service Account, quyền Viewer)
└── <Manga>/
    ├── metadata.json   (title, description, author, artist, status, genres[], otherTitles, cover, banner)
    ├── cover.jpg        (fallback: cover.png/thumbnail.jpg)
    └── <Chapter>/       (tên vd "Ch.236 — Về phương Nam" → number="236", name="Về phương Nam")
        └── 001.jpg ...
```

### Các thành phần (namespace `MangaDrive.Infrastructure.Services`)
- **GoogleDriveService** — bọc Drive API v3. Dùng `UnsafeHttpClientFactory` **bypass SSL** (cho môi trường sau proxy/VPN). Có `ListFolders/Files`, `ListSharedFolders`, `GetFileContent`, `DownloadFile`, và Changes API (`GetStartPageToken`, `GetChanges`).
- **MangaSyncService** (`IMangaSyncService`) — logic sync chính: `SyncRootFolderAsync` (quét cả root) và `SyncSingleMangaAsync`. Đọc metadata, tạo/cập nhật manga→chapter→image, **dọn stale** (xóa cái không còn trên Drive), auto-link, đẩy tiến độ qua `ISyncNotifier`, cập nhật `ChangesPageToken` sau khi xong. Tạo Notification "chapter mới" cho tất cả user đã duyệt khi có chương mới.
- **SyncBackgroundService** (HostedService) — hàng đợi `Channel<SyncRequest>` (`Queue`), worker chạy nền. Mọi controller admin đẩy sync bằng `SyncBackgroundService.Queue.Writer.WriteAsync(new SyncRequest(id, SyncRequestType.RootFolder|Manga))`. (Có `LegacyQueue` giữ tương thích cũ.)
- **AutoSyncService** (HostedService) — poll Drive **Changes API** mỗi **30 phút**. Dùng 1 global page token, map mỗi change → manga bị ảnh hưởng → queue sync có chọn lọc (không full sync trừ khi có manga mới trong root). Cũng tự phát hiện shared folder mới.

### SignalR
- `/hubs/sync` (`SyncHub`) — sự kiện `SyncProgress` broadcast tới **tất cả** client. Payload chi tiết ở `MangaSyncService.SaveAndNotify` (percent, currentManga, currentMangaNewChapters...). `SyncNotifier` (trong Api) implement `ISyncNotifier`.
- `/hubs/comments` (`CommentHub`) — group theo mangaId (`JoinMangaGroup`/`LeaveMangaGroup`), sự kiện `NewComment`.

## Scramble ảnh (chống leech)

Ảnh chapter trên Drive được xáo trộn grid NxN. Frontend **unscramble ở client** bằng canvas.
- Master key chỉ ở backend (`Scramble:MasterKey` / env `SCRAMBLE_MASTER_KEY`). Backend trả key per-chapter = HMAC-SHA256(masterKey, slug) + grid qua endpoint auth/rate-limited; không trả master key.
- `Chapter.Slug` + `Chapter.Grid` lấy từ `manifest.json`; frontend không còn `VITE_SCRAMBLE_KEY` / `VITE_SCRAMBLE_GRID`.
- Google Picker append flow cần `VITE_GOOGLE_API_KEY` (Docker arg từ `GOOGLE_API_KEY`) để chọn manga Drive có sẵn và merge manifest khi thêm chapter.
- Thuật toán ở `lib/scramble.ts` + `components/UnscrambleImage.tsx`: HMAC derived key → seed FNV-1a → PRNG mulberry32 → Fisher-Yates → nghịch đảo để vẽ lại. Lazy-load qua IntersectionObserver (`rootMargin 500px`).
- Ảnh tải qua `fetch(src, { credentials: 'include' })` để gửi cookie `img_token`.

## API endpoints (tóm tắt)

- `POST /api/auth/google-login`, `GET /api/auth/me`, `POST /api/auth/complete-profile`
- `GET /api/mangas` (đầy đủ, filter quyền), `GET /api/mangas/paginated` (page/sort/genre/status), `GET /api/mangas/genres`, `GET /api/mangas/{id}`, `GET /api/mangas/{id}/chapters`
- `GET /api/chapters/{id}` (kèm images + isScrambled)
- `GET /api/images/{fileId}` (stream từ Drive, auth qua cookie)
- `GET/POST /api/mangas/{id}/comments`
- User data (`UserDataController`): favorites, reading-progress, reading-history, continue-reading
- `GET/POST /api/notifications`, unread-count, read-all
- `POST /api/manga-requests`, `GET /api/manga-requests/mine`
- Admin (`api/admin/*`): `root-folders` (CRUD + `scan`, `detect-new-chapters`, `sync`, `sync-new`, `sync-folder`), `mangas` (toggle-visibility, link, reorder-chapters, sync, delete), `users` (approve/disable/delete/permissions), `sync-jobs`, `manga-requests`, `drive/shared-folders`.

## Quy ước & lưu ý khi sửa code

- **DTOs** tập trung ở `MangaDrive.Core/DTOs/Dtos.cs` (records). JSON API dùng **camelCase** (cấu hình trong `Program.cs`).
- **Genres/OtherTitles lưu dạng JSON string** trong DB, không phải cột riêng. Filter genre = `Genres.Contains(...)`.
- **Migrations bất thường**: `Program.cs` chạy `db.Database.Migrate()` rồi còn `ExecuteSqlRaw` thủ công thêm cột/bảng (Notifications, CommentReactions, OtherTitles, Birthday...) với `try/catch` nuốt lỗi. Bảng `Notifications` được `ExcludeFromMigrations`. Khi thêm cột: cân nhắc theo pattern hiện có hoặc tạo migration chuẩn — nhưng biết là có 2 cơ chế song song.
- Tạo migration: `dotnet ef migrations add <Name> --project MangaDrive.Infrastructure --startup-project MangaDrive.Api`.
- **Chạy backend**: `cd backend/MangaDrive.Api && dotnet run` (port 5000). **Frontend**: `cd frontend && npm run dev` (port 5173, Vite proxy `/api` và `/hubs` → 5000).
- Frontend gọi API qua instance `api` trong `lib/api.ts` (tự gắn JWT, tự logout khi 401). Có manga cache 5 phút ở `lib/cache.ts` — nhớ `invalidateMangaCache()` khi dữ liệu đổi.
- Icon dùng Material Symbols (`<span className="ms">progress_activity</span>` v.v.).

## Secrets & config

- Backend: `appsettings.json` chứa `Jwt:Secret`, `Google:ClientId/ClientSecret`, `Google:ServiceAccountKeyPath`, `AdminEmails[]`, `Scramble:Enabled`. Prod override qua env (`__` phân cấp) trong docker-compose.
- Service account key: `backend/MangaDrive.Api/service-account-key.json` (dev) hoặc `secrets/service-account-key.json` (Docker, mount readonly).
- ⚠️ `appsettings.json` và `.env` hiện đang chứa **secret thật** (JWT secret, Google client secret) commit trong repo — coi là nhạy cảm, đừng echo giá trị ra ngoài; nên xoay vòng nếu công khai.

## Deploy

- Dev/local: `docker compose up -d --build` → http://localhost:3000.
- Prod: `docker compose -f docker-compose.prod.yml up -d --build`. Caddy (`Caddyfile`, biến `$DOMAIN`) tự lấy/renew SSL, reverse proxy → frontend (nginx) → backend. Cloudflare proxied, SSL mode Full, bật WebSockets cho SignalR.
- nginx (`frontend/nginx.conf`) proxy `/api` và `/hubs` (có Upgrade header cho WS) → `backend:5000`, còn lại SPA fallback.
- DB SQLite ở volume `db-data` (`/app/data/mangadrive.db`). Tạo admin đầu tiên: dùng `AdminEmails` (khuyến nghị) hoặc `UPDATE Users SET Role='Admin', IsApproved=1`.
- Chi tiết đầy đủ trong `README.md`, `DOCKER.md`, `DEPLOY.md`.
