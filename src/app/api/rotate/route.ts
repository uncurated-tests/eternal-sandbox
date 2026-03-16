import { NextResponse } from "next/server";

import { rotateChain } from "@/lib/sandbox-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    const result = await rotateChain();
    return NextResponse.json(result, { status: result.rotated ? 200 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rotation failed.";
    return NextResponse.json(
      {
        rotated: false,
        checkedAt: new Date().toISOString(),
        note: message,
        previousSandboxId: null,
        previousSnapshotId: null,
        newSandboxId: null,
        newSandboxUrl: null,
        newSnapshotId: null,
        generation: 0,
        prunedSnapshots: [],
      },
      { status: 500 },
    );
  }
}

// Cron hits this as GET
export async function GET() {
  return POST();
}
