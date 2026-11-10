#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node backend/scripts/setup.mjs
echo '初始账号文件：.lingpu/setup-credentials.json（请妥善保管）'
