#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT/.pids"

echo "Stopping dev stack..."
if [ -d "$PID_DIR" ]; then
  for pidfile in "$PID_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null && echo "  Stopped pid $pid ($(basename "$pidfile" .pid))" || true
    rm -f "$pidfile"
  done
fi
for port in 3000 8545; do lsof -ti :"$port" | xargs -r kill -9 2>/dev/null || true; done
echo "All services stopped."
