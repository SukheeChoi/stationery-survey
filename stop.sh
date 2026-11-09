#!/bin/bash
# 설문 수신 서버와 터널 끄기 (DB는 그대로 둠)
pkill -f "node server/server.js" 2>/dev/null
pkill -f "cloudflared tunnel --url http://127.0.0.1:8787" 2>/dev/null
echo "stopped"
