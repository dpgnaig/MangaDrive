# MangaDrive - Docker Deployment

## Yêu cầu

- Docker Engine 24+
- Docker Compose v2+
- Google Cloud project đã cấu hình (xem [README.md](README.md))

## Cấu trúc

```
MangaDrive/
├── docker-compose.yml           ← Development/Local (port 3000)
├── docker-compose.prod.yml      ← Production (Caddy + auto HTTPS)
├── Caddyfile                    ← Caddy reverse proxy config
├── .env                         ← file cấu hình (tạo từ .env.example)
├── secrets/
│   └── service-account-key.json ← Service Account key
├── backend/
│   └── Dockerfile
└── frontend/
    ├── Dockerfile
    └── nginx.conf
```

---

## Local / Development (port 3000)

### 1. Tạo file `.env`

```bash
cp .env.example .env
```

Sửa các giá trị:

| Biến | Mô tả |
|------|--------|
| `JWT_SECRET` | Chuỗi bí mật JWT, ít nhất 32 ký tự |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret |
| `ADMIN_EMAIL` | Email tài khoản admin đầu tiên |
| `SCRAMBLE_KEY` | Key dùng để scramble/unscramble ảnh |
| `SCRAMBLE_GRID` | Grid size (mặc định 6) |

### 2. Đặt Service Account Key

```bash
mkdir secrets
cp path/to/service-account-key.json secrets/
```

### 3. Build và chạy

```bash
docker compose up -d --build
```

Truy cập tại: **http://localhost:3000**

### 4. Dừng

```bash
docker compose down
```

---

## Production (VPS + Domain + Auto HTTPS)

Dùng Caddy làm reverse proxy, tự động lấy và renew SSL certificate từ Let's Encrypt.

### Yêu cầu thêm

- VPS (Ubuntu 22+, 1GB RAM đủ)
- Domain đã trỏ A record về IP VPS

### 1. Setup trên VPS

```bash
# Clone repo
git clone <repo-url> MangaDrive && cd MangaDrive

# Tạo .env
cp .env.example .env
```

Sửa `.env`:

| Biến | Giá trị |
|------|---------|
| `DOMAIN` | `manga.yourdomain.com` (domain thật) |
| `JWT_SECRET` | Chuỗi random dài >= 32 ký tự |
| `GOOGLE_CLIENT_ID` | OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth Client Secret |
| `ADMIN_EMAIL` | Email admin |
| `SCRAMBLE_KEY` | Key scramble (giống với WPF tool) |
| `SCRAMBLE_GRID` | Grid size (giống với WPF tool) |

### 2. Service Account Key

```bash
mkdir secrets
# Upload service-account-key.json vào secrets/
```

### 3. Deploy

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

**Xong!** Truy cập: `https://manga.yourdomain.com`

Caddy tự động:
- Lấy SSL certificate từ Let's Encrypt
- Redirect HTTP → HTTPS
- Renew certificate tự động

### 4. Google Cloud Console

Cập nhật OAuth 2.0 Client:
- **Authorized JavaScript origins**: `https://manga.yourdomain.com`
- **Authorized redirect URIs**: `https://manga.yourdomain.com/login`

---

## Commands chung

```bash
# Xem logs
docker compose [-f docker-compose.prod.yml] logs -f
docker compose [-f docker-compose.prod.yml] logs -f backend

# Rebuild 1 service
docker compose [-f docker-compose.prod.yml] up -d --build frontend
docker compose [-f docker-compose.prod.yml] up -d --build backend

# Restart
docker compose [-f docker-compose.prod.yml] restart

# Dừng
docker compose [-f docker-compose.prod.yml] down
```

## Services

| Service | Port | Mô tả |
|---------|------|--------|
| `caddy` | 80, 443 (prod only) | Auto HTTPS reverse proxy |
| `frontend` | 80 (internal) | Nginx serve SPA + proxy /api, /hubs |
| `backend` | 5000 (internal) | .NET API + SignalR + SQLite |

## Backup database

```bash
# Copy DB ra host
docker compose [-f docker-compose.prod.yml] cp backend:/app/data/mangadrive.db ./backup/
```

## Troubleshooting

| Vấn đề | Giải pháp |
|--------|-----------|
| Frontend trắng | Kiểm tra `GOOGLE_CLIENT_ID` trong `.env` |
| 502 Bad Gateway | Backend chưa start xong, xem logs |
| Google login lỗi | Kiểm tra redirect URI trong Google Cloud Console |
| SSL lỗi (local) | Bình thường nếu dùng proxy/VPN công ty, backend đã bypass |
| Caddy không lấy cert | Kiểm tra domain đã trỏ A record về IP VPS chưa |
| Ảnh scramble không hiển thị | Kiểm tra `SCRAMBLE_KEY` + `SCRAMBLE_GRID` khớp với WPF tool |
