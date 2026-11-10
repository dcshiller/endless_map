#!/usr/bin/env bash
# Serve the map locally and open it in the browser.
#   ./run.sh          # uses port 8000, or the next free one
#   ./run.sh 9000     # start from a specific port
set -euo pipefail

cd "$(dirname "$0")"

port="${1:-8000}"
while ! python3 -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',$port))" 2>/dev/null; do
  port=$((port + 1))
done

url="http://localhost:$port/"
echo "Serving map at $url  (Ctrl+C to stop)"

# Open the browser once the server has had a moment to start.
( sleep 0.5; xdg-open "$url" >/dev/null 2>&1 || open "$url" >/dev/null 2>&1 || true ) &

# A plain static server that tells the browser to re-check files on every load, so edits
# show up on refresh (python's default server lets browsers reuse stale scripts).
exec python3 -c '
import http.server, sys
class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), NoCache).serve_forever()
' "$port"
