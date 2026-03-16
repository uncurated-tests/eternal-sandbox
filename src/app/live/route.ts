import { NextResponse } from "next/server";

import { discoverCurrentChain } from "@/lib/sandbox-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const chain = await discoverCurrentChain();

  if (chain.healthy && chain.current) {
    return NextResponse.redirect(chain.current.sandboxUrl, 302);
  }

  return NextResponse.redirect(new URL("/", process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000"), 302);
}
