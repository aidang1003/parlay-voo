// Next.js server-startup hook. Runs once per server boot; we use it to
// validate env-var propagation between foundry (deploy time) and nextjs
// (runtime). See lib/server/env-check.ts for the actual check.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkEnv } = await import("./lib/server/env-check");
  // Fire-and-forget — don't block server startup on the RPC roundtrip.
  void checkEnv().catch(err => console.warn("[env-check] failed:", err));
}
