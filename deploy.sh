#!/usr/bin/env bash
# Publish the static PWA. There is no build step and no server requirement --
# any static host will do, which is the point: anyone can self-host this.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DEST:-/var/www/bp}"

VERSION="$(find "$ROOT/web" -type f -exec sha256sum {} + | sort -k2 | sha256sum | cut -c1-12)"
sudo mkdir -p "$DEST"
sudo chown "$(id -un):$(id -gn)" "$DEST"
rsync -a --delete "$ROOT/web"/ "$DEST"/
grep -rl __BUILD_VERSION__ "$DEST" | xargs -r sed -i "s/__BUILD_VERSION__/${VERSION}/g"
sudo restorecon -R "$DEST" 2>/dev/null || true
echo "deployed ${VERSION} -> ${DEST}"
