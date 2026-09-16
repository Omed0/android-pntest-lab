#!/usr/bin/env bash
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need bash
need docker
need adb

docker compose version >/dev/null 2>&1 || {
  echo "Missing required command: docker compose (v2)" >&2
  exit 1
}

if ! command -v emulator >/dev/null 2>&1; then
  echo "Warning: emulator not found in PATH; physical device usage is still supported." >&2
fi

echo "Compatibility checks passed"
docker --version
docker compose version
adb version | head -n 1
if command -v emulator >/dev/null 2>&1; then
  emulator -version | head -n 1
fi
