#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/scripts/check-compat.sh"

docker compose -f "$ROOT/docker-compose.yml" up -d

adb start-server >/dev/null
adb devices >/dev/null

echo "Lab started"
docker compose -f "$ROOT/docker-compose.yml" ps
adb devices
