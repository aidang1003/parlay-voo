/** Auth for cron-protected routes.
 *
 *  On Vercel (`VERCEL=1` is always set there), enforce the `Authorization:
 *  Bearer $CRON_SECRET` header — Vercel Cron attaches this automatically when
 *  CRON_SECRET is set in project env.
 *
 *  Off Vercel (local dev, self-hosted), the request is already gated by the
 *  fact that the dev server only listens on localhost, so we skip the bearer
 *  check to avoid shell-level secret plumbing.
 *
 *  See docs/A-DAY.md (F-2) for the rationale on why this check is light-touch. */
export function isAuthorizedCronRequest(req: Request): boolean {
  if (process.env.VERCEL !== "1") return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
