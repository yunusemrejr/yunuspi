#!/usr/bin/env bash
# Render a painterly-canvas scene to PNG with headless Chrome (no npm packages).
# usage: render.sh <scene.js> <out.png> [width] [height] [seed]
# The scene file defines `function scene(canvas, seed)` and uses window.Paint.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scene="$(realpath "$1")"; out="$(realpath -m "$2")"; W="${3:-1080}"; H="${4:-1860}"; SEED="${5:-7}"
chrome="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/page.html" <<EOF
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
<canvas id="c" width="$W" height="$H"></canvas>
<script src="file://$here/paint.js"></script>
<script src="file://$scene"></script>
<script>scene(document.getElementById('c'), $SEED);</script>
EOF
# CPU raster on purpose: GPU canvas work has leaked graphics memory on this machine.
timeout 180 "$chrome" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=1 --window-size="$W,$H" --virtual-time-budget=60000 \
  --screenshot="$out" "file://$tmp/page.html" >/dev/null 2>&1
ls -l "$out"
