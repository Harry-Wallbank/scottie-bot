#!/usr/bin/env bash
# Pulls the latest master and rebuilds/restarts the bot's Docker container.
# Run from this repo's checkout on the server: bash scripts/update.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Fetching latest changes"
git fetch origin master
git merge --ff-only origin/master

echo "==> Building and restarting container"
cd ~/docker
docker compose build bot
docker compose up -d bot

echo "==> Done. Current commit:"
cd - > /dev/null
git log -1 --oneline
