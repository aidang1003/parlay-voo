// Run via `pnpm db:init-admins`. Reads DATABASE_URL from .env.local (which
// the postinstall hook symlinks to the root .env).
import { INITIAL_ADMIN_ADDRESSES, initAdmins } from "../lib/db/admin-schema";
import { sql } from "../lib/db/client";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Add it to .env (root) and re-run.");
    process.exit(1);
  }

  console.log(`[init-admins] seeding ${INITIAL_ADMIN_ADDRESSES.length} hardcoded address(es)`);
  if (INITIAL_ADMIN_ADDRESSES.length === 0) {
    console.warn("[init-admins] INITIAL_ADMIN_ADDRESSES is empty — table will be created with zero rows.");
    console.warn(
      "[init-admins] No wallet will pass the gate until you add one (via UI or by editing admin-schema.ts).",
    );
  }

  const db = sql();
  try {
    const result = await initAdmins(db);
    console.log(`[init-admins] ok — created table; ${result.seeded}/${result.created} new rows inserted`);
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error("[init-admins] failed:", err);
  process.exit(1);
});
