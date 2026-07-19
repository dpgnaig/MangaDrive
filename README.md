# MangaDrive - Manga Reader with Google Drive Integration

## Prerequisites

- .NET 8 SDK
- Node.js 18+
- Google Cloud project with:
  - OAuth 2.0 Client ID (Web application)
  - Service Account with Drive API enabled

## Google Cloud Setup

### 1. Tạo OAuth Client ID (cho user login)

1. Vào [Google Cloud Console](https://console.cloud.google.com)
2. APIs & Services → Credentials → Create Credentials → OAuth Client ID
3. Application type: Web application
4. Authorized JavaScript origins: `http://localhost:5173`
5. Authorized redirect URIs: `http://localhost:5173/login`
6. Copy **Client ID**

### 2. Tạo Service Account (cho backend đọc Drive)

1. APIs & Services → Credentials → Create Credentials → Service Account
2. Tạo key JSON → download file `service-account-key.json`
3. Enable **Google Drive API** trong APIs & Services → Library
4. Share các folder manga trên Google Drive với email của Service Account (quyền **Viewer**)

### 3. Cấu trúc folder trên Google Drive

```
Root Folder (share với Service Account)
├── Manga Name 1/
│   ├── cover.jpg
│   ├── metadata.json
│   ├── Chapter 1/
│   │   ├── 001.jpg
│   │   ├── 002.jpg
│   └── Chapter 2/
│       ├── 001.jpg
└── Manga Name 2/
    └── ...
```

### metadata.json

```json
{
  "title": "One Piece",
  "description": "Mô tả truyện...",
  "author": "Oda Eiichiro",
  "status": "ongoing",
  "genres": ["Action", "Adventure"],
  "cover": "cover.jpg"
}
```

## Backend Setup

```bash
cd backend/MangaDrive.Api

# Cập nhật appsettings.json
# - Jwt:Secret (ít nhất 32 ký tự, thay chuỗi mặc định)
# - Google:ClientId (OAuth Client ID)
# - Google:ClientSecret (OAuth Client Secret)
# - Google:ServiceAccountKeyPath (đường dẫn tới file JSON)

# Copy service account key vào thư mục backend/MangaDrive.Api/
cp ~/Downloads/service-account-key.json .

# Chạy backend
dotnet run
```

Backend chạy tại `http://localhost:5000`

### Tạo Admin user

Khi user đầu tiên đăng nhập, sửa database để set role = "Admin":

```bash
sqlite3 mangadrive.db "UPDATE Users SET Role='Admin', IsApproved=1 WHERE Id=(SELECT Id FROM Users LIMIT 1);"
```

## Frontend Setup

```bash
cd frontend

# Tạo file .env
echo "VITE_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com" > .env

npm install
npm run dev
```

Frontend chạy tại `http://localhost:5173`

## Auth Flow

1. User click "Đăng nhập với Google" → redirect tới Google OAuth (`response_type=code`)
2. Google trả `code` về redirect URI: `http://localhost:5173/login?code=...`
3. Frontend gửi `code` + `redirect_uri` lên `POST /api/auth/google-login`
4. Backend dùng `Client ID` + `Client Secret` + `code` đổi lấy `access_token` từ Google
5. Backend dùng `access_token` gọi Google userinfo API → tạo/cập nhật user → trả JWT
6. Frontend lưu JWT vào localStorage, dùng cho các request sau

## API Endpoints

| Method | Endpoint | Mô tả |
|--------|----------|--------|
| POST | /api/auth/google-login | Đăng nhập Google |
| GET | /api/auth/me | Thông tin user hiện tại |
| GET | /api/mangas | Danh sách manga (có filter quyền) |
| GET | /api/mangas/:id | Chi tiết manga |
| GET | /api/mangas/:id/chapters | Danh sách chapters |
| GET | /api/chapters/:id | Chi tiết chapter + images |
| GET/POST | /api/mangas/:id/comments | Bình luận |
| GET/POST/PUT/DELETE | /api/admin/root-folders | Quản lý Root Folders |
| POST | /api/admin/root-folders/:id/sync | Trigger sync |
| GET | /api/admin/sync-jobs | Danh sách sync jobs |
| POST | /api/admin/users/:id/approve | Approve user |
| POST | /api/admin/users/:id/root-permissions | Cấp quyền root folder |
| POST | /api/admin/users/:id/manga-permissions | Cấp quyền manga |

## SignalR Hubs

- `/hubs/sync` — Realtime sync progress
- `/hubs/comments` — Realtime comments (JoinMangaGroup/LeaveMangaGroup)

## Architecture

```
backend/
├── MangaDrive.Api/          # Controllers, Hubs, Program.cs
├── MangaDrive.Core/         # Entities, DTOs, Interfaces
└── MangaDrive.Infrastructure/  # DbContext, Services, Migrations

frontend/
└── src/
    ├── context/             # AuthContext
    ├── lib/                 # API client
    └── pages/              # React pages
        └── admin/          # Admin pages
```
