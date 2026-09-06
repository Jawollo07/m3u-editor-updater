#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/m3u-editor-updater}"
CONFIG_DIR="$INSTALL_DIR/config"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required."; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 20 )) || { echo "Node.js 20+ is required. Found: $(node --version)"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required."; exit 1; }

mkdir -p "$INSTALL_DIR/config"
if [[ ! -f "$INSTALL_DIR/updater.js" ]]; then
  echo "Run this installer from the cloned repository or set INSTALL_DIR to the repository directory."
  exit 1
fi

if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  cp "$CONFIG_DIR/config.example.json" "$CONFIG_DIR/config.json"
  echo "Created $CONFIG_DIR/config.json"
  echo "Edit projectDir before enabling the timer."
fi

install -m 0644 systemd/m3u-editor-updater.service /etc/systemd/system/m3u-editor-updater.service
install -m 0644 systemd/m3u-editor-updater.timer /etc/systemd/system/m3u-editor-updater.timer
systemctl daemon-reload

"$INSTALL_DIR/updater.js" --dry-run || true

echo
echo "Installation prepared."
echo "1. Edit: $CONFIG_DIR/config.json"
echo "2. Test: sudo M3U_UPDATER_CONFIG=$CONFIG_DIR/config.json node $INSTALL_DIR/updater.js --dry-run"
echo "3. Enable: sudo systemctl enable --now m3u-editor-updater.timer"
