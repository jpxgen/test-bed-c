#!/usr/bin/env bash
# Makes sure the project's pinned toolchain is present: uv for python/ and pnpm
# for ts/. Installs each only when it is missing, so a prepared machine (a kit
# session, a developer's checkout) never touches the network here; the bare
# gates runner does. The versions are the ones the ci workflow installs.
set -euo pipefail
UV_VERSION="0.8.17"
PNPM_VERSION="10.33.0"
command -v uv >/dev/null 2>&1 || python3 -m pip install --quiet "uv==$UV_VERSION"
command -v pnpm >/dev/null 2>&1 || npm install -g --ignore-scripts "pnpm@$PNPM_VERSION"
