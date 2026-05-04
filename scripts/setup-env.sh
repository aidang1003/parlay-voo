#!/usr/bin/env bash
# Installs symlinks that point each package's local env file at the root .env,
# so the project has a single source of truth for env vars across nextjs +
# foundry. Idempotent — safe to re-run from postinstall / predev / predeploy.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [ ! -f .env ]; then
  echo "⚠  scripts/setup-env.sh: root .env missing. Copy .env.example → .env and fill it in, then re-run pnpm install."
  exit 0   # exit 0 so postinstall doesn't break pnpm install on first clone
fi

ln -sf ../../.env packages/foundry/.env
ln -sf ../../.env packages/nextjs/.env.local

echo "✓ env symlinks installed:"
echo "  packages/foundry/.env       → $(readlink packages/foundry/.env)"
echo "  packages/nextjs/.env.local  → $(readlink packages/nextjs/.env.local)"
