#!/bin/bash
set -e

# ============================================
# MangaDrive Deploy Script (Ubuntu)
# WAL-safe SQLite DB preservation during rebuild
# ============================================

COMPOSE_FILE="docker-compose.prod.yml"
DB_VOLUME="mangadrive_db-data"        # named volume holding /app/data
DB_NAME="mangadrive.db"
BACKUP_DIR="./db-backup"              # holds .db + -wal + -shm

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ------------------------------------------------------------------
# Menu: pick what to deploy
# Can be passed as arg 1 (fresh|fe|be|all) for non-interactive use.
# ------------------------------------------------------------------
MODE="$1"
if [ -z "$MODE" ]; then
    echo -e "${GREEN}=== MangaDrive Deploy ===${NC}"
    echo "  1) Xoá DB và build lại từ đầu (fresh)"
    echo "  2) Chỉ build Frontend"
    echo "  3) Chỉ build Backend"
    echo "  4) Build tất cả (giữ nguyên DB)"
    echo "  5) Dọn Docker (system prune -a -f)"
    read -rp "Chọn [1-5]: " choice
    case "$choice" in
        1) MODE="fresh" ;;
        2) MODE="fe" ;;
        3) MODE="be" ;;
        4) MODE="all" ;;
        5) MODE="prune" ;;
        *) echo -e "${RED}Lựa chọn không hợp lệ${NC}"; exit 1 ;;
    esac
fi

echo -e "${GREEN}=== MangaDrive Deploy (mode: $MODE) ===${NC}"

# ==================================================================
# Helper functions
# ==================================================================
backup_db() {
    echo -e "${YELLOW}[backup] Backing up database from volume...${NC}"
    if docker volume inspect "$DB_VOLUME" >/dev/null 2>&1; then
        mkdir -p "$BACKUP_DIR"
        docker run --rm \
            -v "$DB_VOLUME":/data \
            -v "$(pwd)/$BACKUP_DIR":/backup \
            alpine sh -c "cp -a /data/. /backup/ 2>/dev/null || true"
        if [ -f "$BACKUP_DIR/$DB_NAME" ]; then
            echo -e "  ✓ DB backed up to $BACKUP_DIR ($(du -h "$BACKUP_DIR/$DB_NAME" | cut -f1))"
        else
            echo -e "  ⚠ Volume had no DB yet (first deploy?)"
        fi
    else
        echo -e "  ⚠ Volume $DB_VOLUME not found, skipping backup"
    fi
}

pull_code() {
    echo -e "${YELLOW}[git] Pulling latest code...${NC}"
    if [ -d ".git" ]; then
        git pull && echo -e "  ✓ Code updated"
    else
        echo -e "  ⚠ Not a git repo, skipping pull"
    fi
}

# Restore DB from backup only when the volume lost its DB. Never overwrite
# a live volume. Runs while nothing holds the DB open, clearing stale WAL/SHM.
verify_or_restore_db() {
    echo -e "${YELLOW}[db] Verifying database in volume...${NC}"
    VOLUME_HAS_DB=$(docker run --rm -v "$DB_VOLUME":/data alpine \
        sh -c "[ -f /data/$DB_NAME ] && echo yes || echo no")

    if [ "$VOLUME_HAS_DB" = "yes" ]; then
        echo -e "  ✓ Volume already holds the DB — kept as-is (no overwrite)"
    elif [ -f "$BACKUP_DIR/$DB_NAME" ]; then
        echo -e "  ⚠ Volume DB missing — restoring from backup..."
        docker run --rm \
            -v "$DB_VOLUME":/data \
            -v "$(pwd)/$BACKUP_DIR":/backup \
            alpine sh -c "cp -a /backup/$DB_NAME /data/$DB_NAME && rm -f /data/$DB_NAME-wal /data/$DB_NAME-shm"
        echo -e "  ✓ DB restored (stale WAL/SHM cleared)"
    else
        echo -e "  ⚠ No volume DB and no backup — starting fresh"
    fi
}

health_check() {
    sleep 3
    if docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}} {{.Status}}' | grep backend | grep -q "Up"; then
        echo -e "${GREEN}✓ Deploy complete! All services running.${NC}"
    else
        echo -e "${RED}✗ Backend may have issues. Check logs:${NC}"
        echo "  docker compose -f $COMPOSE_FILE logs backend --tail 50"
    fi
}

# ==================================================================
# Mode: fresh — wipe the DB and rebuild everything from scratch
# ==================================================================
if [ "$MODE" = "fresh" ]; then
    echo -e "${RED}!!! Chế độ FRESH sẽ XOÁ toàn bộ dữ liệu trong volume '$DB_VOLUME' !!!${NC}"
    read -rp "Gõ 'DELETE' để xác nhận: " confirm
    if [ "$confirm" != "DELETE" ]; then
        echo -e "${YELLOW}Đã huỷ.${NC}"
        exit 0
    fi

    echo -e "${YELLOW}[1/4] Backing up old DB before wipe (safety)...${NC}"
    backup_db

    echo -e "${YELLOW}[2/4] Tearing down and removing DB volume...${NC}"
    docker compose -f "$COMPOSE_FILE" down
    docker volume rm "$DB_VOLUME" 2>/dev/null && echo -e "  ✓ Volume removed" || echo -e "  ⚠ Volume not present"

    pull_code

    echo -e "${YELLOW}[3/4] Building all containers...${NC}"
    docker compose -f "$COMPOSE_FILE" build

    echo -e "${YELLOW}[4/4] Starting services (fresh DB)...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d
    echo ""
    health_check
    exit 0
fi

# ==================================================================
# Mode: fe — build & recreate frontend only (DB untouched)
# ==================================================================
if [ "$MODE" = "fe" ]; then
    pull_code
    echo -e "${YELLOW}[1/2] Building frontend...${NC}"
    docker compose -f "$COMPOSE_FILE" build frontend
    echo -e "${YELLOW}[2/2] Recreating frontend...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d frontend
    echo ""
    echo -e "${GREEN}✓ Frontend deployed.${NC}"
    exit 0
fi

# ==================================================================
# Mode: be — build & recreate backend only (DB preserved)
# ==================================================================
if [ "$MODE" = "be" ]; then
    echo -e "${YELLOW}[1/5] Stopping backend for a clean checkpoint...${NC}"
    docker compose -f "$COMPOSE_FILE" stop backend 2>/dev/null || true

    backup_db
    pull_code

    echo -e "${YELLOW}[4/5] Building backend...${NC}"
    docker compose -f "$COMPOSE_FILE" build backend

    verify_or_restore_db

    echo -e "${YELLOW}[5/5] Recreating backend...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d backend
    echo ""
    health_check
    exit 0
fi

# ==================================================================
# Mode: all — build everything, preserve DB (default behavior)
# ==================================================================
if [ "$MODE" = "all" ]; then
    # Step 1: Stop backend so SQLite closes cleanly (checkpoints WAL).
    echo -e "${YELLOW}[1/6] Stopping backend for a clean checkpoint...${NC}"
    docker compose -f "$COMPOSE_FILE" stop backend 2>/dev/null || true

    # Step 2: Backup the whole data dir straight from the volume.
    backup_db

    # Step 3: Pull latest code.
    pull_code

    # Step 4: Build and tear down (named volumes survive `down`).
    echo -e "${YELLOW}[4/6] Building and recreating containers...${NC}"
    docker compose -f "$COMPOSE_FILE" build
    docker compose -f "$COMPOSE_FILE" down

    # Step 5: Volume is source of truth; restore only if it lost the DB.
    verify_or_restore_db

    # Step 6: Start all services.
    echo -e "${YELLOW}[6/6] Starting services...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d
    echo ""
    health_check
    exit 0
fi

# ==================================================================
# Mode: prune — reclaim disk by removing unused Docker data.
# `system prune -a` deletes ALL images not used by a running container,
# plus stopped containers, unused networks and the build cache. Named
# volumes are NOT touched (no --volumes), so the DB volume is safe.
# The next build will re-pull/rebuild images from scratch (slower).
# ==================================================================
if [ "$MODE" = "prune" ]; then
    echo -e "${YELLOW}Dọn Docker: xoá image không dùng, container đã dừng, network thừa, build cache.${NC}"
    echo -e "${GREEN}Volume (DB) được giữ nguyên — không dùng --volumes.${NC}"
    read -rp "Gõ 'PRUNE' để xác nhận: " confirm
    if [ "$confirm" != "PRUNE" ]; then
        echo -e "${YELLOW}Đã huỷ.${NC}"
        exit 0
    fi
    docker system prune -a -f
    echo -e "${GREEN}✓ Đã dọn Docker.${NC}"
    exit 0
fi

echo -e "${RED}Mode không hợp lệ: $MODE (dùng: fresh|fe|be|all|prune)${NC}"
exit 1
