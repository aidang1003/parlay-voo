// See docs/changes/C_USER_FEEDBACK.md for design rationale (modular init,
// seed-as-floor semantics, separation from SCHEMA_SQL).
import type { Sql } from "postgres";

const hardcodedAdminAddresses = ["0x31Fdeb452632Cb502bF145B275E0F0d98C4732D6"];

const userWalletAddress = process.env.USER_WALLET_ADDRESS?.trim();
const rawInitialAdminAddresses = hardcodedAdminAddresses.concat(userWalletAddress ? [userWalletAddress] : []);

export const INITIAL_ADMIN_ADDRESSES: string[] = [
  ...new Set(rawInitialAdminAddresses.map(address => address.toLowerCase())),
];

export const ADMIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tbadminwallet (
  txtaddress    TEXT PRIMARY KEY CHECK (txtaddress ~ '^0x[0-9a-f]{40}$'),
  txtnote       TEXT,
  txtaddedby    TEXT,
  tscreatedat   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Idempotent. ON CONFLICT DO NOTHING means removing an address from
// INITIAL_ADMIN_ADDRESSES does not delete it from the DB.
export async function initAdmins(sql: Sql): Promise<{ created: number; seeded: number }> {
  await sql.unsafe(ADMIN_SCHEMA_SQL);

  let seeded = 0;
  for (const raw of INITIAL_ADMIN_ADDRESSES) {
    const addr = raw.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      throw new Error(`INITIAL_ADMIN_ADDRESSES: invalid address ${JSON.stringify(raw)}`);
    }
    const result = await sql`
      INSERT INTO tbadminwallet (txtaddress, txtnote, txtaddedby)
      VALUES (${addr}, 'seed', 'init-script')
      ON CONFLICT (txtaddress) DO NOTHING
    `;
    if (result.count > 0) seeded++;
  }

  return { created: INITIAL_ADMIN_ADDRESSES.length, seeded };
}
