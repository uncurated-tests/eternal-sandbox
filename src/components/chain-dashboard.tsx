"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ChainStatusResponse, PulsePoint } from "@/lib/types";

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatTime(ts: number | null) {
  if (!ts) return "-";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "2-digit" }).format(ts);
}

function PulseStrip({ pulses }: { pulses: PulsePoint[] }) {
  const trimmed = pulses.slice(-24);

  if (!trimmed.length) {
    return <p className="text-sm text-muted-foreground">Waiting for first heartbeat.</p>;
  }

  return (
    <div className="flex h-20 items-end gap-0.5" aria-hidden="true">
      {trimmed.map((p) => (
        <span
          key={p.timestamp}
          className={cn(
            "min-w-1.5 flex-1 rounded-full",
            p.phase === "steady" && "bg-foreground",
            p.phase === "handoff" && "bg-muted-foreground/50",
            p.phase === "recovered" && "bg-muted-foreground",
          )}
          style={{ height: 12 + Math.min(Math.abs(p.driftMs), 200) / 4 }}
        />
      ))}
    </div>
  );
}

export function ChainDashboard({ initialStatus }: { initialStatus: ChainStatusResponse }) {
  const [status, setStatus] = useState(initialStatus);
  const [now, setNow] = useState(Date.now());
  const [booting, setBooting] = useState(false);
  const [bootErr, setBootErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const go = async () => {
      try {
        const r = await fetch("/api/chain", { cache: "no-store" });
        setStatus((await r.json()) as ChainStatusResponse);
      } catch { /* ignore */ }
    };
    go();
    const t = setInterval(go, 15_000);
    return () => clearInterval(t);
  }, []);

  const c = status.current;

  const m = useMemo(() => {
    if (!c) return null;
    return {
      sandbox: now - c.status.sandboxStartedAt,
      chain: now - c.status.genesisAt,
      handoff: Math.max(0, c.status.nextRotationAt - now),
    };
  }, [c, now]);

  const boot = async () => {
    setBootErr(null);
    setBooting(true);
    try {
      const r = await fetch("/api/bootstrap", { method: "POST", headers: { "content-type": "application/json" } });
      const p = (await r.json()) as ChainStatusResponse;
      if (!r.ok) throw new Error(p.note ?? "Failed to start.");
      setStatus(p);
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : "Failed to start.");
    } finally {
      setBooting(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-14">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Eternal Sandbox</h1>
          <Badge
            variant="outline"
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] uppercase tracking-widest",
              status.healthy
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-border text-muted-foreground",
            )}
          >
            {status.healthy ? "Live" : "Idle"}
          </Badge>
        </div>

        {c ? (
          <Button asChild size="sm">
            <a href={c.sandboxUrl} target="_blank" rel="noreferrer">
              Open sandbox <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        ) : (
          <Button size="sm" onClick={boot} disabled={booting}>
            {booting ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
            {booting ? "Launching..." : "Launch chain"}
          </Button>
        )}
      </div>

      {bootErr && <p className="text-sm text-destructive">{bootErr}</p>}

      {c && m ? (
        <>
          {/* ── Counters ── */}
          <section className="grid grid-cols-3 gap-4">
            {([
              ["Sandbox uptime", formatDuration(m.sandbox)],
              ["Chain uptime", formatDuration(m.chain)],
              ["Next handoff", formatDuration(m.handoff)],
            ] as const).map(([label, value]) => (
              <Card key={label}>
                <CardContent className="px-4 py-4">
                  <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">{label}</p>
                  <p className="mt-2 font-mono text-2xl font-semibold tracking-tight sm:text-3xl">{value}</p>
                </CardContent>
              </Card>
            ))}
          </section>

          {/* ── Details + Pulse ── */}
          <section className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Generation" value={String(c.status.generation)} />
                <Row label="Heartbeats" value={String(c.status.heartbeatCount)} />
                <Row label="Last heartbeat" value={formatTime(c.status.lastHeartbeatAt)} />
                <Row label="Source snapshot" value={c.status.sourceSnapshotId ?? "unknown"} truncate />
                <Row label="Sandbox ID" value={c.status.sandboxId ?? c.sandboxId} truncate />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Pulse</CardTitle>
              </CardHeader>
              <CardContent>
                <PulseStrip pulses={c.status.pulseHistory} />
              </CardContent>
            </Card>
          </section>

          {/* ── Explainer ── */}
          <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-foreground select-none">
              How does this work?
            </summary>
            <div className="mt-3 space-y-2 leading-relaxed text-muted-foreground">
              <p>This project runs a single dedicated sandbox chain. The controller (this Vercel app) manages the lifecycle.</p>
              <p>
                <strong className="text-foreground">Bootstrap:</strong> If no sandbox is running, the controller looks for the newest
                Vercel Sandbox snapshot in this project. If one exists, it boots from that snapshot. If none exist yet, it creates an
                initial base snapshot from the GitHub repo.
              </p>
              <p>
                <strong className="text-foreground">Rotation:</strong> A cron job calls <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">POST /api/rotate</code> every
                5 minutes. When the live sandbox enters the handoff window, the controller snapshots it. That snapshot captures the
                full filesystem state. The old sandbox stops automatically. A new sandbox boots from that fresh snapshot.
              </p>
              <p>
                <strong className="text-foreground">Persistence:</strong> Because rotation snapshots capture the entire disk, any files
                you create or modify (including installed packages) carry over to the next generation. This is checkpoint-based
                persistence, not a continuously durable disk. If the sandbox crashes before rotation, writes since the last snapshot
                are lost.
              </p>
              <p>
                <strong className="text-foreground">Retention:</strong> The controller keeps the 3 most recent snapshots and prunes
                older ones after each successful rotation.
              </p>
            </div>
          </details>
        </>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">No sandbox chain is running. Launch one to start the live counter.</p>
            <Button size="sm" onClick={boot} disabled={booting}>
              {booting ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
              {booting ? "Starting..." : "Start chain"}
            </Button>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function Row({ label, value, truncate }: { label: string; value: string; truncate?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("text-right", truncate && "max-w-[180px] truncate")}>{value}</span>
    </div>
  );
}
