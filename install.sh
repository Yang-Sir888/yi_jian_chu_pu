#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npm --prefix backend ci --no-audit --no-fund
npm --prefix frontend ci --no-audit --no-fund
npm --prefix frontend run build
echo '安装完成，请运行 bash start.sh。'
