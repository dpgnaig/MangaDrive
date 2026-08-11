# MangaDrive - Hướng dẫn Deploy Production

## Server Requirements

- Ubuntu 22.04+ (EC2 hoặc VPS)
- Docker & Docker Compose
- Domain: `mangadrive.xyz` (trỏ A record về Elastic IP)
- Elastic IP: `52.14.41.100`

---

## 1. Cài đặt Docker trên EC2

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Cài Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Logout rồi login lại để apply group
exit
```

Sau khi login lại, kiểm tra:
```bash
docker --version
docker compose version
```

---

## 2. Upload source code lên server

### Cách 1: Git clone
```bash
cd ~
git clone <your-repo-url> MangaDrive
cd MangaDrive
```

### Cách 2: SCP từ local (Windows)
```powershell
scp -i "your-key.pem" -r . ubuntu@52.14.41.100:~/MangaDrive/
```

### Cách 3: FileZilla/WinSCP
Upload toàn bộ project vào `/home/ubuntu/MangaDrive/`

---

## 3. Cấu hình secrets

### 3.1 Tạo thư mục secrets và set quyền

```bash
cd ~/MangaDrive
mkdir -p secrets
sudo chown -R $USER:$USER secrets/
chmod 755 secrets/
```

### 3.2 Upload service-account-key.json

**Cách 1 — SCP từ local:**
```powershell
scp -i "your-key.pem" service-account-key.json ubuntu@52.14.41.100:~/MangaDrive/secrets/
```

**Cách 2 — Paste trực tiếp trên server:**
```bash
cat > ~/MangaDrive/secrets/service-account-key.json << 'EOF'
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "...@...iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token"
}
EOF
```

**Kiểm tra:**
```bash
ls -la secrets/service-account-key.json
# Phải thấy file với size > 0
```

---

## 4. Tạo file .env

```bash
cat > ~/MangaDrive/.env << 'EOF'
DOMAIN=mangadrive.xyz
JWT_SECRET=<chuỗi-random-ít-nhất-32-ký-tự>
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
GOOGLE_API_KEY=<your-browser-restricted-picker-api-key>
ADMIN_EMAIL=<your-email@gmail.com>
SCRAMBLE_MASTER_KEY=<your-scramble-master-key>
SCRAMBLE_ENABLED=true
EOF
```

> **Tạo JWT_SECRET random:**
> ```bash
> openssl rand -hex 32
> ```

---

## 5. Cấu hình Security Group (AWS)

Vào AWS Console → EC2 → Security Groups, mở các port:

| Port | Protocol | Source | Mục đích |
|------|----------|--------|----------|
| 22 | TCP | My IP | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP |
| 443 | TCP | 0.0.0.0/0 | HTTPS |
| 443 | UDP | 0.0.0.0/0 | HTTP/3 (QUIC) |

> **Bảo mật nâng cao:** Thay `0.0.0.0/0` bằng [Cloudflare IP ranges](https://www.cloudflare.com/ips/) để chặn truy cập trực tiếp.

---

## 6. Cấu hình Cloudflare

### 6.1 Thêm domain vào Cloudflare
1. Cloudflare Dashboard → Add Site → `mangadrive.xyz`
2. Chọn plan Free

### 6.2 Đổi Nameserver trên Mắt Bão
Thay NS mặc định bằng NS của Cloudflare (hiện trong dashboard sau khi add site).

### 6.3 DNS Records

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | @ | 52.14.41.100 | ✅ Proxied |
| A | www | 52.14.41.100 | ✅ Proxied |

### 6.4 SSL/TLS
- Mode: **Full** (Caddy tự cấp Let's Encrypt cert)
- Always Use HTTPS: ✅ On
- Minimum TLS: 1.2

### 6.5 Redirect www → root
Rules → Redirect Rules:
- When: Hostname = `www.mangadrive.xyz`
- Then: 301 → `https://mangadrive.xyz${http.request.uri.path}`

### 6.6 Network
- WebSockets: ✅ On (cho SignalR)

---

## 7. Google OAuth Console

Vào https://console.cloud.google.com → APIs & Services → Credentials → OAuth Client ID:

**Authorized JavaScript origins:**
```
https://mangadrive.xyz
http://localhost:5173
```

**Authorized redirect URIs:**
```
https://mangadrive.xyz/login
http://localhost:5173/login
```

---

## 8. Deploy

```bash
cd ~/MangaDrive

# Build và chạy
docker compose -f docker-compose.prod.yml up -d --build

# Xem logs
docker compose -f docker-compose.prod.yml logs -f

# Kiểm tra tất cả containers running
docker compose -f docker-compose.prod.yml ps
```

---

## 9. Kiểm tra

```bash
# Test backend
curl http://localhost:5000/api/auth/me

# Test frontend
curl http://localhost:80

# Test full (qua Caddy)
curl -I https://mangadrive.xyz
```

---

## 10. Quản lý

### Xem logs
```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f frontend
docker compose -f docker-compose.prod.yml logs -f caddy
```

### Restart
```bash
docker compose -f docker-compose.prod.yml restart
```

### Rebuild sau khi update code
```bash
cd ~/MangaDrive
git pull  # hoặc upload code mới
docker compose -f docker-compose.prod.yml up -d --build
```

### Stop
```bash
docker compose -f docker-compose.prod.yml down
```

### Xóa sạch (⚠️ mất database)
```bash
docker compose -f docker-compose.prod.yml down -v
```

---

## 11. Tạo Admin User

Sau khi user đầu tiên đăng nhập:

```bash
# Vào container backend
docker compose -f docker-compose.prod.yml exec backend sh

# Hoặc dùng sqlite3 trực tiếp
docker compose -f docker-compose.prod.yml exec backend sh -c \
  "apt-get update && apt-get install -y sqlite3 && sqlite3 /app/data/mangadrive.db \"UPDATE Users SET Role='Admin', IsApproved=1 WHERE Email='your-email@gmail.com';\""
```

---

## 12. Backup Database

```bash
# Copy db ra host
docker compose -f docker-compose.prod.yml exec backend cp /app/data/mangadrive.db /app/data/backup-$(date +%Y%m%d).db

# Hoặc copy ra host filesystem
docker cp $(docker compose -f docker-compose.prod.yml ps -q backend):/app/data/mangadrive.db ./backup-mangadrive.db
```

---

## Cấu trúc thư mục trên server

```
/home/ubuntu/MangaDrive/
├── .env                          # Biến môi trường
├── Caddyfile                     # Caddy reverse proxy config
├── docker-compose.prod.yml       # Docker compose production
├── secrets/
│   └── service-account-key.json  # Google Service Account key
├── backend/                      # Source code backend
│   └── Dockerfile
└── frontend/                     # Source code frontend
    └── Dockerfile
```

---

## Troubleshooting

### Container không start
```bash
docker compose -f docker-compose.prod.yml logs backend
```

### Permission denied trên secrets/
```bash
sudo chown -R $USER:$USER ~/MangaDrive/secrets/
chmod 755 ~/MangaDrive/secrets/
chmod 644 ~/MangaDrive/secrets/service-account-key.json
```

### SSL không hoạt động
- Kiểm tra Cloudflare SSL mode = Full
- Kiểm tra Caddy logs: `docker compose -f docker-compose.prod.yml logs caddy`
- Đảm bảo port 80 và 443 mở trên Security Group

### Database bị lock
```bash
docker compose -f docker-compose.prod.yml restart backend
```

### Cập nhật code
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```
