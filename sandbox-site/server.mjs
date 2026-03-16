import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

const APP_PORT = Number(process.env.APP_PORT ?? 3000);
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 4 * 60 * 60 * 1000);
const ROTATION_LEAD_MS = Number(process.env.ROTATION_LEAD_MS ?? 5 * 60 * 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 15 * 1000);
const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const STATE_FILE = path.join(REPO_ROOT, "sandbox-site", "runtime-state.json");

let state = await loadOrCreateState();
await persistState();

setInterval(async () => {
  await recordHeartbeat();
}, HEARTBEAT_INTERVAL_MS).unref();

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (requestUrl.pathname === "/status") {
    return respondJson(response, buildStatusPayload());
  }

  if (requestUrl.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  if (requestUrl.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderPage(buildStatusPayload()));
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(APP_PORT, () => {
  console.log(`Eternal sandbox page is listening on :${APP_PORT}`);
});

// ── state ──

async function loadOrCreateState() {
  try {
    const existing = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return normalizeState(existing);
  } catch {
    return normalizeState({
      chainId: process.env.CHAIN_ID ?? randomUUID(),
      generation: Number(process.env.GENERATION ?? 1),
      genesisAt: Number(process.env.GENESIS_AT ?? Date.now()),
      sandboxStartedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      heartbeatCount: 0,
      pulseHistory: [],
      currentSandboxId: process.env.CURRENT_SANDBOX_ID ?? null,
      sourceSnapshotId: process.env.SOURCE_SNAPSHOT_ID ?? null,
      nextRotationAt: Date.now() + Math.max(30_000, SANDBOX_TIMEOUT_MS - ROTATION_LEAD_MS),
    });
  }
}

function normalizeState(input) {
  const startedAt = Number(input.sandboxStartedAt ?? Date.now());
  const nextRotationAt = Number(input.nextRotationAt ?? startedAt + Math.max(30_000, SANDBOX_TIMEOUT_MS - ROTATION_LEAD_MS));

  return {
    chainId: input.chainId ?? randomUUID(),
    generation: Number(input.generation ?? 1),
    genesisAt: Number(input.genesisAt ?? startedAt),
    sandboxStartedAt: startedAt,
    lastHeartbeatAt: Number(input.lastHeartbeatAt ?? startedAt),
    heartbeatCount: Number(input.heartbeatCount ?? 0),
    pulseHistory: Array.isArray(input.pulseHistory) ? input.pulseHistory.slice(-48) : [],
    currentSandboxId: input.currentSandboxId ?? process.env.CURRENT_SANDBOX_ID ?? null,
    sourceSnapshotId: input.sourceSnapshotId ?? process.env.SOURCE_SNAPSHOT_ID ?? null,
    nextRotationAt,
  };
}

async function persistState() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function recordHeartbeat() {
  const now = Date.now();
  const expected = state.lastHeartbeatAt + HEARTBEAT_INTERVAL_MS;
  const driftMs = state.heartbeatCount === 0 ? 0 : now - expected;

  state.lastHeartbeatAt = now;
  state.heartbeatCount += 1;
  state.pulseHistory = [
    ...state.pulseHistory,
    { timestamp: now, driftMs, phase: "steady" },
  ].slice(-48);

  await persistState();
}

// ── status ──

function buildStatusPayload() {
  const now = Date.now();

  return {
    healthy: true,
    chainId: state.chainId,
    generation: state.generation,
    sandboxId: state.currentSandboxId,
    sourceSnapshotId: state.sourceSnapshotId,
    sandboxStartedAt: state.sandboxStartedAt,
    sandboxUptimeMs: now - state.sandboxStartedAt,
    genesisAt: state.genesisAt,
    chainUptimeMs: now - state.genesisAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    heartbeatCount: state.heartbeatCount,
    nextRotationAt: state.nextRotationAt,
    msUntilRotation: Math.max(0, state.nextRotationAt - now),
    pulseHistory: state.pulseHistory,
  };
}

function respondJson(response, payload) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// ── rendering ──

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "2-digit",
  }).format(timestamp);
}

function renderPulseBars(status) {
  return status.pulseHistory
    .slice(-24)
    .map((pulse) => {
      const height = 12 + Math.min(Math.abs(pulse.driftMs), 200) / 4;
      return `<span class="pulse-bar pulse-${pulse.phase}" style="height:${height}px"></span>`;
    })
    .join("");
}

function renderPage(status) {
  const sandboxUptime = formatDuration(status.sandboxUptimeMs);
  const chainUptime = formatDuration(status.chainUptimeMs);
  const rotationCountdown = formatDuration(status.msUntilRotation);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <title>Eternal Sandbox</title>
    <style>
      :root {
        --bg: #fafafa; --fg: #09090b; --card: #fff; --muted: #f4f4f5;
        --muted-fg: #71717a; --border: #e4e4e7;
      }
      * { box-sizing: border-box; margin: 0; }
      body {
        min-height: 100vh; background: var(--bg); color: var(--fg);
        font-family: "Geist", ui-sans-serif, system-ui, -apple-system, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      a { color: inherit; }
      .shell { width: min(640px, calc(100% - 2rem)); margin: 0 auto; padding: 2.5rem 0 4rem; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      .badge {
        display: inline-flex; align-items: center; border-radius: 999px;
        padding: 0.3rem 0.6rem; font-size: 0.7rem; font-weight: 600;
        letter-spacing: 0.12em; text-transform: uppercase;
        border: 1px solid #d1fae5; background: #ecfdf5; color: #047857;
      }
      .title { display: flex; align-items: center; gap: 0.6rem; }
      .title h1 { font-size: 1rem; font-weight: 600; letter-spacing: -0.02em; }
      .btn {
        display: inline-flex; align-items: center; gap: 0.35rem;
        padding: 0.45rem 0.8rem; border-radius: 0.5rem; font-size: 0.82rem; font-weight: 500;
        background: var(--fg); color: var(--bg); text-decoration: none; border: none; cursor: pointer;
      }
      .btn-ghost { background: var(--card); color: var(--fg); border: 1px solid var(--border); }
      .counter { margin-top: 2rem; text-align: center; }
      .counter .label {
        font-size: 0.7rem; font-weight: 600; letter-spacing: 0.14em;
        text-transform: uppercase; color: var(--muted-fg);
      }
      .counter .value {
        margin-top: 0.5rem;
        font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: clamp(2.8rem, 8vw, 4.5rem); font-weight: 600;
        letter-spacing: -0.06em; line-height: 1;
      }
      .counter .sub { margin-top: 0.6rem; font-size: 0.85rem; color: var(--muted-fg); }
      .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.6rem; margin-top: 1.5rem; }
      .card {
        border: 1px solid var(--border); border-radius: 0.75rem;
        background: var(--card); padding: 0.9rem;
      }
      .card .label {
        font-size: 0.65rem; font-weight: 600; letter-spacing: 0.14em;
        text-transform: uppercase; color: var(--muted-fg);
      }
      .card .num {
        margin-top: 0.35rem;
        font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 1.5rem; font-weight: 600; letter-spacing: -0.04em;
      }
      .detail { margin-top: 1.5rem; }
      .detail-row {
        display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
        padding: 0.5rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem;
      }
      .detail-row:last-child { border-bottom: none; }
      .detail-row .dl { color: var(--muted-fg); }
      .detail-row .dv { text-align: right; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pulse-section { margin-top: 1.5rem; }
      .pulse-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted-fg); }
      .pulse-wrap {
        margin-top: 0.6rem; display: flex; align-items: flex-end; gap: 2px;
        height: 4.5rem; border: 1px solid var(--border); border-radius: 0.5rem;
        background: var(--muted); padding: 0.5rem;
      }
      .pulse-bar { flex: 1; min-width: 4px; border-radius: 999px; background: #e4e4e7; }
      .pulse-steady { background: #18181b; }
      .pulse-handoff { background: #a1a1aa; }
      .pulse-recovered { background: #52525b; }
      .note { margin-top: 0.75rem; font-size: 0.82rem; color: var(--muted-fg); line-height: 1.6; }
      .link { color: var(--fg); }
      .error { color: #b91c1c; }
      @media (max-width: 640px) {
        .shell { padding-top: 1.2rem; }
        .grid { grid-template-columns: 1fr; }
        .row { flex-wrap: wrap; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="row">
        <div class="title">
          <h1>Eternal Sandbox</h1>
          <span class="badge">Gen ${status.generation}</span>
        </div>
        <a class="btn-ghost btn" href="/status">Status JSON</a>
      </div>

      <div class="counter">
        <p class="label">This sandbox has been alive for</p>
        <p class="value" id="sandbox-counter">${sandboxUptime}</p>
        <p class="sub">Chain uptime <span id="chain-uptime">${chainUptime}</span> &middot; Next handoff <span id="rotation-countdown">${rotationCountdown}</span></p>
      </div>

      <div class="grid">
        <div class="card">
          <p class="label">Heartbeats</p>
          <p class="num" id="heartbeat-count">${status.heartbeatCount}</p>
        </div>
        <div class="card">
          <p class="label">Last heartbeat</p>
          <p class="num" id="last-heartbeat">${formatClock(status.lastHeartbeatAt)}</p>
        </div>
      </div>

      <div class="pulse-section">
        <p class="pulse-label">Pulse</p>
        <div class="pulse-wrap" id="pulse-strip">${renderPulseBars(status)}</div>
      </div>

      <div class="detail">
        <div class="detail-row"><span class="dl">Sandbox ID</span><span class="dv">${status.sandboxId ?? "unknown"}</span></div>
        <div class="detail-row"><span class="dl">Source snapshot</span><span class="dv">${status.sourceSnapshotId ?? "unknown"}</span></div>
        <div class="detail-row"><span class="dl">Chain started</span><span class="dv">${formatClock(status.genesisAt)}</span></div>
      </div>

      <p class="note">
        Filesystem changes persist across generations. When this sandbox rotates, the controller snapshots
        its full disk state and boots the next generation from that snapshot.
      </p>
    </div>

    <script>
      const initialStatus = ${JSON.stringify(status)};
      let s = initialStatus;

      function fmt(ms) {
        const t = Math.max(0, Math.floor(ms / 1000));
        return String(Math.floor(t/3600)).padStart(2,"0") + ":" + String(Math.floor((t%3600)/60)).padStart(2,"0") + ":" + String(t%60).padStart(2,"0");
      }

      function clk(ts) {
        return new Intl.DateTimeFormat("en", { hour:"2-digit", minute:"2-digit", second:"2-digit", month:"short", day:"2-digit" }).format(ts);
      }

      function tick() {
        const now = Date.now();
        document.getElementById("sandbox-counter").textContent = fmt(now - s.sandboxStartedAt);
        document.getElementById("chain-uptime").textContent = fmt(now - s.genesisAt);
        document.getElementById("rotation-countdown").textContent = fmt(Math.max(0, s.nextRotationAt - now));
      }

      function bars(h) {
        document.getElementById("pulse-strip").innerHTML = h.slice(-24).map((p) => {
          const ht = 12 + Math.min(Math.abs(p.driftMs), 200) / 4;
          return '<span class="pulse-bar pulse-' + p.phase + '" style="height:' + ht + 'px"></span>';
        }).join("");
      }

      async function refresh() {
        try {
          const r = await fetch("/status", { cache: "no-store" });
          if (!r.ok) return;
          s = await r.json();
          document.getElementById("heartbeat-count").textContent = s.heartbeatCount;
          document.getElementById("last-heartbeat").textContent = clk(s.lastHeartbeatAt);
          bars(s.pulseHistory || []);
        } catch {}
      }

      tick();
      setInterval(tick, 1000);
      refresh();
      setInterval(refresh, 15000);
    </script>
  </body>
</html>`;
}
