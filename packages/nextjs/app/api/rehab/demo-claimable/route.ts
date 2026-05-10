/**
 * Demo rehab claimable. Returns the sum of stakes from this wallet's
 * demo-Lost ticket deviations that haven't yet been redeemed through the demo
 * rehab flow. Mirrors the chain `HouseVault.rehabClaimable[user]` mapping;
 * `useRehabClaimable` adds this to the chain value so the user sees a
 * combined balance on the rehab CTA + claim screens.
 *
 * The two pots are intentionally independent: when the chain later resolves
 * the same ticket as a real Loss, the chain accrues its own rehabClaimable
 * normally and we don't try to subtract the demo amount. Phantom credit
 * stays in the user's wallet — testnet MockUSDC is free.
 */
import { NextResponse } from "next/server";
import { getDemoRehabClaimable } from "~~/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wallet = (searchParams.get("wallet") ?? "").toLowerCase();
  if (!ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet address required" }, { status: 400 });
  }
  const claimable = await getDemoRehabClaimable(wallet);
  return NextResponse.json({ claimable: claimable.toString() });
}
