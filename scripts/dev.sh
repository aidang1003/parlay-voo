#!/usr/bin/env bash
# Boot local dev stack: anvil + deploy + next dev.
# Thin wrapper that invokes the same pnpm scripts a developer runs manually
# (pnpm chain / pnpm deploy:local / pnpm dev) so there's one code path to maintain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT/.pids"
mkdir -p "$PID_DIR"

if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

# Local dev always reads from Anvil; override any .env that points the web app
# at Base Sepolia so the page isn't blank before the wallet connects.
export NEXT_PUBLIC_CHAIN_ID=31337

echo "Starting ParlayVoo dev stack..."
for port in 3000 8545; do lsof -ti :"$port" | xargs -r kill -9 2>/dev/null || true; done
sleep 1

nohup pnpm -C "$ROOT" chain > "$PID_DIR/anvil.log" 2>&1 &
echo $! > "$PID_DIR/anvil.pid"
echo "  Anvil started (pid $(cat "$PID_DIR/anvil.pid")) on :8545"
sleep 2

pnpm -C "$ROOT" deploy:local > "$PID_DIR/deploy.log" 2>&1
echo "  Contracts deployed, deployedContracts.ts regenerated"

nohup pnpm -C "$ROOT" dev > "$PID_DIR/web.log" 2>&1 &
echo $! > "$PID_DIR/web.pid"
echo "  Web started (pid $(cat "$PID_DIR/web.pid")) on :3000"
sleep 3

echo ""
echo "Dev stack running. 'pnpm dev-stop' to shut down."
echo "  Anvil: http://localhost:8545"
echo "  Web:   http://localhost:3000"
echo "Logs in $PID_DIR/*.log"
