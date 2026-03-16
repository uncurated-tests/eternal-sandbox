"use client";

import { useEffect, useMemo, useState } from "react";

import type { ChainStatusResponse, PulsePoint } from "@/lib/types";

type DashboardProps = {
  initialStatus: ChainStatusResponse;
};

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatTime(timestamp: number | null) {
  if (!timestamp) {
    return "-";
  }

  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "2-digit",
  }).format(timestamp);
}

function PulseStrip({ pulses }: { pulses: PulsePoint[] }) {
  const trimmed = pulses.slice(-24);

  if (!trimmed.length) {
    return <div className="pulse-empty">No heartbeats captured yet.</div>;
  }

  return (
    <div className="pulse-strip" aria-hidden="true">
      {trimmed.map((pulse) => {
        const height = 26 + Math.min(Math.abs(pulse.driftMs), 140) / 2;
        return (
          <span
            key={pulse.timestamp}
            className={`pulse-bar pulse-${pulse.phase}`}
            style={{ height }}
            title={`${pulse.phase} ${pulse.driftMs}ms`}
          />
        );
      })}
    </div>
  );
}

export function ChainDashboard({ initialStatus }: DashboardProps) {
  const [status, setStatus] = useState(initialStatus);
  const [now, setNow] = useState(Date.now());
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const refresh = async () => {
      try {
        const response = await fetch("/api/chain", { cache: "no-store" });
        const next = (await response.json()) as ChainStatusResponse;
        setStatus(next);
      } catch {
        // Ignore transient refresh failures.
      }
    };

    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const current = status.current;

  const metrics = useMemo(() => {
    if (!current) {
      return null;
    }

    const sandboxUptimeMs = now - current.status.sandboxStartedAt;
    const chainUptimeMs = now - current.status.genesisAt;
    const rotationCountdown = Math.max(0, current.status.nextRotationAt - now);

    return {
      sandboxUptimeMs,
      chainUptimeMs,
      rotationCountdown,
    };
  }, [current, now]);

  const handleBootstrap = async () => {
    setBootstrapError(null);
    setIsBootstrapping(true);

    try {
      const response = await fetch("/api/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      });

      const payload = (await response.json()) as ChainStatusResponse;
      if (!response.ok) {
        throw new Error(payload.note ?? "The sandbox chain could not be started.");
      }

      setStatus(payload);
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : "The sandbox chain could not be started.");
    } finally {
      setIsBootstrapping(false);
    }
  };

  return (
    <main className="shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Self-rotating sandbox chain</p>
          <h1>Eternal Sandbox</h1>
          <p className="lede">
            A live Vercel Sandbox page that keeps passing the baton to a fresh snapshot-backed sibling before
            timeout, while this control surface tracks the currently alive generation.
          </p>
        </div>

        <div className="hero-panel">
          <div className={`status-pill ${status.healthy ? "is-healthy" : "is-waiting"}`}>
            {status.healthy ? "Live" : "Idle"}
          </div>
          <p className="panel-caption">Checked {formatTime(Date.parse(status.checkedAt))}</p>
          {current ? (
            <a className="panel-link" href={current.sandboxUrl} target="_blank" rel="noreferrer">
              Open current sandbox page
            </a>
          ) : (
            <button className="panel-link button-reset" onClick={handleBootstrap} disabled={isBootstrapping}>
              {isBootstrapping ? "Launching chain..." : "Launch sandbox chain"}
            </button>
          )}
          {bootstrapError ? <p className="error-text">{bootstrapError}</p> : null}
        </div>
      </section>

      {current && metrics ? (
        <>
          <section className="counter-grid">
            <article className="metric-card accent-coral">
              <p className="metric-label">Sandbox alive for</p>
              <p className="metric-value">{formatDuration(metrics.sandboxUptimeMs)}</p>
              <p className="metric-meta">Generation {current.status.generation}</p>
            </article>

            <article className="metric-card accent-cyan">
              <p className="metric-label">Chain alive for</p>
              <p className="metric-value">{formatDuration(metrics.chainUptimeMs)}</p>
              <p className="metric-meta">Started {formatTime(current.status.genesisAt)}</p>
            </article>

            <article className="metric-card accent-gold">
              <p className="metric-label">Next handoff in</p>
              <p className="metric-value">{formatDuration(metrics.rotationCountdown)}</p>
              <p className="metric-meta">Rotates before sandbox timeout hits</p>
            </article>
          </section>

          <section className="detail-grid">
            <article className="detail-card">
              <p className="detail-title">Live chain details</p>
              <dl className="detail-list">
                <div>
                  <dt>Sandbox ID</dt>
                  <dd>{current.status.sandboxId ?? current.sandboxId}</dd>
                </div>
                <div>
                  <dt>Base snapshot</dt>
                  <dd>{current.status.baseSnapshotId ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>Heartbeat count</dt>
                  <dd>{current.status.heartbeatCount}</dd>
                </div>
                <div>
                  <dt>Last heartbeat</dt>
                  <dd>{formatTime(current.status.lastHeartbeatAt)}</dd>
                </div>
              </dl>
            </article>

            <article className="detail-card pulse-card">
              <p className="detail-title">Pulse strip</p>
              <PulseStrip pulses={current.status.pulseHistory} />
              <p className="pulse-note">Each bar is an internal heartbeat from the currently live sandbox.</p>
            </article>

            <article className="detail-card handoff-card">
              <p className="detail-title">Handoff state</p>
              <p className="handoff-copy">
                {current.status.nextSandboxUrl
                  ? "A replacement sandbox is ready. The live page will redirect visitors toward it before shutdown."
                  : current.status.rotation.inProgress
                    ? "The current sandbox is preparing its successor from the base snapshot."
                    : "The current sandbox is steady and has not started the next handoff yet."}
              </p>
              {current.status.nextSandboxUrl ? (
                <a className="panel-link compact-link" href={current.status.nextSandboxUrl} target="_blank" rel="noreferrer">
                  Open next sandbox
                </a>
              ) : null}
              {current.status.rotation.error ? <p className="error-text">{current.status.rotation.error}</p> : null}
            </article>
          </section>
        </>
      ) : (
        <section className="empty-state">
          <p className="empty-title">No sandbox chain is running yet.</p>
          <p className="empty-copy">
            Launch the chain and this page will start tracking the live sandbox counter, heartbeat pulse, and the
            upcoming snapshot handoff.
          </p>
          <button className="empty-button" onClick={handleBootstrap} disabled={isBootstrapping}>
            {isBootstrapping ? "Starting sandbox..." : "Start the first sandbox"}
          </button>
          {status.note ? <p className="empty-note">{status.note}</p> : null}
        </section>
      )}
    </main>
  );
}
