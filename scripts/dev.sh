#!/usr/bin/env bash
# Boot local dev stack: anvil + deploy + next dev. Replaces `make dev`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT/.pids"
mkdir -p "$PID_DIR"

if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

echo "Starting ParlayVoo dev stack..."
for port in 3000 8545; do lsof -ti :"$port" | xargs -r kill -9 2>/dev/null || true; done
sleep 1

nohup anvil > "$PID_DIR/anvil.log" 2>&1 &
echo $! > "$PID_DIR/anvil.pid"
echo "  Anvil started (pid $(cat "$PID_DIR/anvil.pid")) on :8545"
sleep 2

(cd "$ROOT/packages/foundry" && forge clean > /dev/null 2>&1 || true)
(cd "$ROOT/packages/foundry" && env -u USDC_ADDRESS forge script script/Deploy.s.sol \
  --broadcast --rpc-url http://127.0.0.1:8545 > "$PID_DIR/deploy.log" 2>&1)
env -u USDC_ADDRESS npx tsx "$ROOT/scripts/sync-env.ts"
echo "  Contracts deployed, .env.local synced"

(cd "$ROOT/packages/nextjs" && nohup pnpm dev > "$PID_DIR/web.log" 2>&1 &
 echo $! > "$PID_DIR/web.pid")
echo "  Web started (pid $(cat "$PID_DIR/web.pid")) on :3000"
sleep 3

echo ""
echo "Dev stack running. 'pnpm dev:stop' to shut down."
echo "  Anvil: http://localhost:8545"
echo "  Web:   http://localhost:3000"
echo "Logs in $PID_DIR/*.log"
