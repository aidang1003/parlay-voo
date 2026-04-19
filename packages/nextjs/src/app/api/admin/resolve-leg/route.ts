/**
 * Spawns the Foundry ResolveLeg script for the F-6 debug page. Chain-gated to
 * Anvil (31337) and Base Sepolia (84532); 404s on mainnet. Script signs with
 * DEPLOYER_PRIVATE_KEY, so the connected wallet is irrelevant.
 *
 * Body: { sourceRef: string, status: 1 | 2 | 3 } (1=Won, 2=Lost, 3=Voided).
 */

import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { LOCAL_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@parlaycity/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  const script =
    chainId === LOCAL_CHAIN_ID
      ? "resolve-leg:local"
      : chainId === BASE_SEPOLIA_CHAIN_ID
        ? "resolve-leg:sepolia"
        : null;
  if (!script) {
    return NextResponse.json({ error: "Not available on this chain" }, { status: 404 });
  }

  let body: { sourceRef?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceRef = body.sourceRef;
  const status = body.status;
  if (typeof sourceRef !== "string" || !sourceRef) {
    return NextResponse.json({ error: "sourceRef required" }, { status: 400 });
  }
  if (status !== 1 && status !== 2 && status !== 3) {
    return NextResponse.json({ error: "status must be 1, 2, or 3" }, { status: 400 });
  }

  const repoRoot = path.resolve(process.cwd(), "..", "..");

  try {
    const { stdout, stderr } = await execFileAsync(
      "pnpm",
      [script, sourceRef, String(status)],
      { cwd: repoRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return NextResponse.json({ ok: true, stdout, stderr });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return NextResponse.json(
      {
        ok: false,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        code: err.code ?? null,
        error: err.message,
      },
      { status: 500 },
    );
  }
}
