#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d frontend/node_modules ]; then npm --prefix frontend ci; fi
npm --prefix frontend run build
