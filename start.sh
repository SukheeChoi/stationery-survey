#!/bin/bash
# 설문 수신 서버 + Cloudflare 터널을 켜고, 터널 주소를 api.json에 반영해 GitHub Pages에 올립니다.
# 사용: ./start.sh   (끄기: ./stop.sh)
set -euo pipefail
cd "$(dirname "$0")"

mysqladmin ping >/dev/null 2>&1 || brew services start mariadb

pkill -f "node server/server.js" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:8787" 2>/dev/null || true

touch server/events.log
nohup node server/server.js > server/server.out 2>&1 &
nohup caffeinate -is cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate > server/tunnel.out 2>&1 &

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' server/tunnel.out | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -z "$URL" ] && { echo "터널 주소를 못 받았어요. server/tunnel.out 확인"; exit 1; }

printf '{"url": "%s"}\n' "$URL" > api.json
if ! git diff --quiet -- api.json; then
  git add api.json && git commit -qm "Update API tunnel URL" && git push -q
fi
echo "API: $URL"
echo "설문: https://sukheechoi.github.io/stationery-survey/"
