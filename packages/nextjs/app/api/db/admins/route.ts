// Cron-gated CRUD for the admin allowlist. Reached from the browser via the
// /api/admin/admins proxy. See docs/changes/C_USER_FEEDBACK.md.
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "~~/lib/cron-auth";
import { addAdmin, listAdmins, removeAdmin } from "~~/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const rows = await listAdmins();
    return NextResponse.json({ admins: rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { address?: unknown; note?: unknown; addedBy?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.address !== "string") {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  const addedBy = typeof body.addedBy === "string" ? body.addedBy : null;

  try {
    await addAdmin({ address: body.address, note, addedBy });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address query param required" }, { status: 400 });
  }
  try {
    const result = await removeAdmin(address);
    return NextResponse.json({ ok: true, removed: result.removed });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
