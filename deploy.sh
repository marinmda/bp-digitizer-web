#!/usr/bin/env bash
# Publish the static PWA. There is no build step and no server requirement --
# any static host will do, which is the point: anyone can self-host this.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DEST:-/var/www/bp}"

# The build scripts are part of the version: they decide how assets are
# rewritten, so a change to them must produce new urls. Otherwise a fixed
# build ships under a hash clients already have cached.
VERSION="$(find "$ROOT/web" "$ROOT/bin" "$ROOT/deploy.sh" -type f \
  -exec sha256sum {} + | sort -k2 | sha256sum | cut -c1-12)"
sudo mkdir -p "$DEST"
sudo chown "$(id -un):$(id -gn)" "$DEST"
rsync -a --delete "$ROOT/web"/ "$DEST"/
grep -rl __BUILD_VERSION__ "$DEST" | xargs -r sed -i "s/__BUILD_VERSION__/${VERSION}/g"

"$ROOT/bin/version-imports.py" "$DEST" "$VERSION"

sudo restorecon -R "$DEST" 2>/dev/null || true
echo "deployed ${VERSION} -> ${DEST}"
