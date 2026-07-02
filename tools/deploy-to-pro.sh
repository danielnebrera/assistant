#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  Promoción a PRODUCCIÓN (pro).                                             ║
# ║  Vive en /assistant (herramienta COMÚN de plataforma, evolucionable por    ║
# ║  git pull para todas las apps). NO debe vivir en el repo de la app.        ║
# ║                                                                            ║
# ║  Flujo:  backup BD pro → git pull (worktree pro) → npm install si cambió    ║
# ║          → migraciones (env=pro) → pm2 restart → healthcheck.               ║
# ║  Todo lo destructivo va DESPUÉS del backup; ante cualquier fallo, aborta    ║
# ║  (set -e) e imprime cómo revertir.                                          ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── Config (todo override-able por variable de entorno) ─────────────────────────
PRO_DIR="${PRO_DIR:-/home/factory/app/pro}"
ENV_NAME="${ENV_NAME:-pro}"
BRANCH="${DEPLOY_BRANCH:-pro}"
PM2_NAME="${PM2_NAME:-Factory-pro}"
BACKUP_DIR="${BACKUP_DIR:-/home/factory/app/backups}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5700/}"     # main de pro
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATE="${MIGRATE:-$SCRIPT_DIR/migrate.js}"
ASSUME_YES=0
DRY_RUN=0

for a in "$@"; do
    case "$a" in
        -y|--yes)    ASSUME_YES=1 ;;
        --dry-run)   DRY_RUN=1 ;;
        -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "arg desconocido: $a"; exit 1 ;;
    esac
done

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────────────
log "Preflight"
[ -d "$PRO_DIR/.git" ] || [ -f "$PRO_DIR/.git" ] || die "$PRO_DIR no es un worktree git (¿worktree roto? repáralo antes)"
git -C "$PRO_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "git no funciona en $PRO_DIR (worktree roto)"
command -v mysqldump >/dev/null || die "falta mysqldump"
command -v pm2 >/dev/null       || die "falta pm2"
command -v node >/dev/null      || die "falta node"
[ -f "$MIGRATE" ]               || die "no encuentro el runner: $MIGRATE"

# Credenciales de BD del .env central de pro (NO del entorno del shell).
ENVF="$PRO_DIR/.env"
[ -f "$ENVF" ] || die "no encuentro $ENVF"
getenv() { grep -E "^\s*$1\s*=" "$ENVF" | tail -1 | cut -d= -f2- | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
DB_HOST="$(getenv DB_HOST)";     DB_HOST="${DB_HOST:-127.0.0.1}"
DB_USER="$(getenv DB_USER)";     DB_USER="${DB_USER:-factory}"
DB_PASSWORD="$(getenv DB_PASSWORD)"
DB_DATABASE="$(getenv DB_DATABASE)"; DB_DATABASE="${DB_DATABASE:-factory}"
PREFIX="${ENV_NAME}_"
MYSQL=(mysql -h"$DB_HOST" -u"$DB_USER" ${DB_PASSWORD:+-p"$DB_PASSWORD"} "$DB_DATABASE")
DUMP=(mysqldump -h"$DB_HOST" -u"$DB_USER" ${DB_PASSWORD:+-p"$DB_PASSWORD"} --single-transaction --no-tablespaces "$DB_DATABASE")

OLD_COMMIT="$(git -C "$PRO_DIR" rev-parse HEAD)"
git -C "$PRO_DIR" fetch --quiet origin "$BRANCH"
NEW_COMMIT="$(git -C "$PRO_DIR" rev-parse "origin/$BRANCH")"
ok "pro=$PRO_DIR  env=$ENV_NAME  BD=$DB_DATABASE prefijo=$PREFIX  pm2=$PM2_NAME"
echo "   commit actual:  $OLD_COMMIT"
echo "   commit destino: $NEW_COMMIT (origin/$BRANCH)"
if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then warn "el worktree ya está en el commit destino (solo se aplicarán migraciones pendientes y restart)"; fi

if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN — cambios de código pendientes:"
    git -C "$PRO_DIR" --no-pager diff --stat "$OLD_COMMIT" "$NEW_COMMIT" | tail -30 || true
    log "DRY-RUN — migraciones pendientes:"
    node "$MIGRATE" status --env="$ENV_NAME" --app-dir="$PRO_DIR" || true
    ok "DRY-RUN completo (no se ha tocado nada)."
    exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
    printf '\n\033[1;33m¿Desplegar a PRODUCCIÓN (%s)? Se hará backup, reset --hard a %s, migrate y restart. [escribe: si] \033[0m' "$ENV_NAME" "$BRANCH"
    read -r ans; [ "$ans" = "si" ] || die "cancelado por el usuario"
fi

# ── 1) Backup de la BD (tablas del entorno) ─────────────────────────────────────
log "1/5 Backup de la BD ($PREFIX*)"
mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/${ENV_NAME}_db_${TS}.sql.gz"
mapfile -t TABLES < <("${MYSQL[@]}" -N -e "SHOW TABLES LIKE '${PREFIX}%'")
[ "${#TABLES[@]}" -gt 0 ] || die "no hay tablas ${PREFIX}* que respaldar (¿prefijo/BD mal?)"
"${DUMP[@]}" "${TABLES[@]}" | gzip > "$BACKUP_FILE"
ok "backup: $BACKUP_FILE (${#TABLES[@]} tablas)"
# Backup de ficheros de código con cambios locales no versionados (por si acaso).
if ! git -C "$PRO_DIR" diff --quiet; then
    DIRTY="$BACKUP_DIR/${ENV_NAME}_dirty_${TS}.patch"
    git -C "$PRO_DIR" diff > "$DIRTY"
    warn "había cambios locales en el worktree → guardados en $DIRTY (se sobrescriben con reset --hard)"
fi

# ── 2) Traer el código (worktree pro → origin/pro) ──────────────────────────────
log "2/5 git reset --hard origin/$BRANCH"
git -C "$PRO_DIR" reset --hard "origin/$BRANCH"
ok "código en $(git -C "$PRO_DIR" rev-parse --short HEAD)"

# ── 3) npm install SOLO donde cambió package.json ───────────────────────────────
log "3/5 Dependencias (npm install donde cambió package.json)"
CHANGED_PKGS="$(git -C "$PRO_DIR" diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" -- '**/package.json' 'package.json' 2>/dev/null || true)"
if [ -n "$CHANGED_PKGS" ]; then
    echo "$CHANGED_PKGS" | xargs -n1 dirname | sort -u | while read -r d; do
        log "   npm install en $d"
        ( cd "$PRO_DIR/$d" && npm install --no-audit --no-fund --omit=dev )
    done
    ok "dependencias actualizadas"
else
    ok "sin cambios en package.json — no hace falta npm install"
fi

# ── 4) Migraciones de BD (incrementales, env=pro) ───────────────────────────────
log "4/5 Migraciones de BD"
node "$MIGRATE" up --env="$ENV_NAME" --app-dir="$PRO_DIR"

# ── 5) Reiniciar el proceso ─────────────────────────────────────────────────────
log "5/5 pm2 restart $PM2_NAME"
pm2 restart "$PM2_NAME" --update-env

# ── Healthcheck ─────────────────────────────────────────────────────────────────
log "Healthcheck $HEALTH_URL"
HEALTHY=0
for i in 1 2 3 4 5 6; do
    sleep 2
    code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)"
    if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then HEALTHY=1; ok "responde HTTP $code"; break; fi
    echo "   intento $i: HTTP $code …"
done

echo
if [ "$HEALTHY" = "1" ]; then
    ok "DEPLOY OK  $OLD_COMMIT → $(git -C "$PRO_DIR" rev-parse --short HEAD)"
else
    warn "el proceso no respondió sano; revisa 'pm2 logs $PM2_NAME'"
fi
cat <<EOF

Revertir si algo va mal:
  git -C $PRO_DIR reset --hard $OLD_COMMIT
  zcat $BACKUP_FILE | ${MYSQL[*]}
  pm2 restart $PM2_NAME --update-env
EOF
