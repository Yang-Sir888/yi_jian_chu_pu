#!/usr/bin/env bash
# 本地回归：重建临时库 → 初始化 → 启动服务 → 端到端接口验收 → 关闭
# 依赖本机 Docker 中的 postgres 容器；连接串请用 .env.local 提供，不要写死在仓库里。
set -euo pipefail
DB="${LOCAL_TEST_DATABASE_URL:-}"
if [ -z "$DB" ]; then
  echo "请先设置 LOCAL_TEST_DATABASE_URL（例如 postgres://用户:密码@localhost:5432/lupu_verify）。" >&2
  exit 2
fi
DB_NAME="lupu_verify"
PORT="${PORT:-4188}"
BASE="http://127.0.0.1:${PORT}"
ART="$(mktemp -d)/credentials.json"

docker exec postgres psql -U postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null
docker exec postgres psql -U postgres -c "CREATE DATABASE ${DB_NAME};" >/dev/null

cd "$(dirname "$0")/.."
DATABASE_URL="$DB" SETUP_ARTIFACT="$ART" node scripts/setup.mjs >/dev/null
DATABASE_URL="$DB" NODE_ENV=development APP_ORIGIN="$BASE" PORT="$PORT" node src/index.mjs >/tmp/verify-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

ADMIN_PASS=$(node -e "console.log(require('$ART').admin.initialPassword)")
node tests/e2e.mjs "$BASE" admin "$ADMIN_PASS" "${1:-/tmp/sample.wav}"
