#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-$(whoami)}}"
NODE_BIN="${NODE_BIN:-$(which node)}"

echo "=== Installing systemd services ==="
echo "Repo: $REPO_DIR"
echo "User: $SERVICE_USER"
echo "Node: $NODE_BIN"
echo

# Bridge service
cat > /etc/systemd/system/matron-bridge.service << EOF
[Unit]
Description=Matron Bridge
After=network.target docker.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env
ExecStart=$NODE_BIN $REPO_DIR/index.js
Restart=always
RestartSec=5
Environment=PATH=/home/$SERVICE_USER/.local/bin:/home/$SERVICE_USER/.claude/bin:/usr/local/bin:/usr/bin:/bin
Environment=ELECTRON_RUN_AS_NODE=

[Install]
WantedBy=multi-user.target
EOF

# Viewer service
cat > /etc/systemd/system/matron-bridge-viewer.service << EOF
[Unit]
Description=Code File Viewer for Matron Bridge (signed URL file server)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env
ExecStart=$NODE_BIN $REPO_DIR/viewer/start.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable matron-bridge matron-bridge-viewer
systemctl restart matron-bridge matron-bridge-viewer

echo
echo "✅ Services installed and started:"
systemctl status matron-bridge --no-pager -l | head -5
echo "---"
systemctl status matron-bridge-viewer --no-pager -l | head -5
