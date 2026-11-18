#!/bin/bash
# Green Room — install Cloudflare Tunnel (cloudflared) as a boot service.
#
#   ./deploy/macos/setup-tunnel.sh <TUNNEL_TOKEN>
#
# Get the token from Cloudflare Zero Trust → Networks → Tunnels → your tunnel
# (the long string after "cloudflared service install"). See docs/DEPLOY-MAC.md.
set -euo pipefail
TOKEN="${1:-}"
[[ -n "$TOKEN" ]] || { echo "Usage: $0 <TUNNEL_TOKEN>"; exit 1; }
[[ "$(uname)" == "Darwin" ]] || { echo "This script is for macOS."; exit 1; }

if ! command -v cloudflared >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "==> Installing cloudflared with Homebrew"
    brew install cloudflared
  else
    ARCH="$(uname -m)"; [[ "$ARCH" == "arm64" ]] || ARCH="amd64"
    echo "==> Downloading cloudflared ($ARCH)"
    TMP="$(mktemp -d)"
    curl -fsSL -o "$TMP/cf.tgz" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${ARCH}.tgz"
    tar -xzf "$TMP/cf.tgz" -C "$TMP"
    sudo install -m 755 "$TMP/cloudflared" /usr/local/bin/cloudflared
    rm -rf "$TMP"
  fi
fi
echo "Using $(command -v cloudflared) ($(cloudflared --version 2>&1 | head -1))"

echo "==> Installing the tunnel service (you may be asked for your Mac password)"
sudo cloudflared service uninstall >/dev/null 2>&1 || true
sudo cloudflared service install "$TOKEN"
echo "Done. In the Cloudflare dashboard the tunnel should show as HEALTHY within a minute."
