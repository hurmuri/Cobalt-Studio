#!/usr/bin/env bash
# 在本机（无 Docker）拉起一个 cobalt API 实例，默认监听 http://localhost:9000/
# 要求: node >= 18, pnpm, ffmpeg（git 可选，没有则用 tarball 下载源码）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$DIR/cobalt-api"
PORT="${PORT:-9000}"
TARBALL="https://codeload.github.com/imputnet/cobalt/tar.gz/refs/heads/main"

for bin in node pnpm ffmpeg; do
  command -v "$bin" >/dev/null 2>&1 || { echo "缺少 $bin，请先安装"; exit 1; }
done

if [ ! -d "$REPO/api" ]; then
  echo "==> 获取 cobalt 源码"
  if command -v git >/dev/null 2>&1 && git clone --depth 1 https://github.com/imputnet/cobalt "$REPO" 2>/dev/null; then
    echo "    via git clone"
  else
    echo "    git 不可用/被挡，改用 codeload tarball"
    tmp="$(mktemp -d)"
    curl -fsSL "$TARBALL" -o "$tmp/cobalt.tar.gz"
    tar -xzf "$tmp/cobalt.tar.gz" -C "$tmp"
    mv "$tmp"/cobalt-* "$REPO"
    rm -rf "$tmp"
  fi
fi

cd "$REPO"

if [ ! -d node_modules ]; then
  echo "==> pnpm install（首次几分钟，含 ffmpeg-static / isolated-vm 等原生模块）"
  pnpm install
fi

cd "$REPO/api"
if [ ! -f .env ]; then
  echo "==> 写入 .env"
  cat > .env <<EOF
API_URL=http://localhost:${PORT}/
API_PORT=${PORT}
API_LISTEN_ADDRESS=127.0.0.1
CORS_WILDCARD=1
RATELIMIT_WINDOW=60
RATELIMIT_MAX=200
DURATION_LIMIT=10800
EOF
fi

echo "==> 启动 cobalt api :${PORT}（Ctrl+C 停止）"
pnpm start
