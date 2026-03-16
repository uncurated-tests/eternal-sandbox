import { NextResponse } from "next/server";

import { bootstrapChain, discoverCurrentChain } from "@/lib/sandbox-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    await bootstrapChain();
    const payload = await discoverCurrentChain();
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not bootstrap the sandbox chain.";
    return NextResponse.json(
      {
        healthy: false,
        checkedAt: new Date().toISOString(),
        note: message,
        current: null,
        candidates: [],
      },
      { status: 500 },
    );
  }
}
