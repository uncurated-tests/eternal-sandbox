import { NextResponse } from "next/server";

import { discoverCurrentChain } from "@/lib/sandbox-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await discoverCurrentChain();
  return NextResponse.json(payload);
}
