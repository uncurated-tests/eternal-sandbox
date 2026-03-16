import { ChainDashboard } from "@/components/chain-dashboard";
import { discoverCurrentChain } from "@/lib/sandbox-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const initialStatus = await discoverCurrentChain();

  return <ChainDashboard initialStatus={initialStatus} />;
}
