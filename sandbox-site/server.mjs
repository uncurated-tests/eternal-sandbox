import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

const APP_PORT = Number(process.env.APP_PORT ?? 3000);
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 40 * 60 * 1000);
const ROTATION_LEAD_MS = Number(process.env.ROTATION_LEAD_MS ?? 5 * 60 * 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 15 * 1000);
const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const STATE_FILE = path.join(REPO_ROOT, "sandbox-site", "runtime-state.json");
const HANDOFF_REDIRECT_GRACE_MS = 20_000;

const authKeys = [
  "VERCEL_OIDC_TOKEN",
  "VERCEL_ACCESS_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
];

function normalizeSandboxUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
}


let state = await loadOrCreateState();
let rotationTimer = null;
let stopTimer = null;

await persistState();
scheduleRotation();

setInterval(async () => {
  await recordHeartbeat();
  if (!state.rotation.inProgress && Date.now() >= state.nextRotationAt) {
    rotateChain("heartbeat-threshold").catch((error) => {
      console.error("Rotation attempt failed", error);
    });
  }
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

async function loadOrCreateState() {
  try {
    const existing = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return normalizeState(existing);
  } catch {
    const resumeState = decodeResumeState();
    return normalizeState({
      chainId: process.env.CHAIN_ID ?? resumeState.chainId ?? randomUUID(),
      generation: Number(process.env.GENERATION ?? resumeState.generation ?? 1),
      genesisAt: Number(process.env.GENESIS_AT ?? resumeState.genesisAt ?? Date.now()),
      sandboxStartedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      heartbeatCount: Number(resumeState.heartbeatCount ?? 0),
      pulseHistory: resumeState.pulseHistory ?? [],
      currentSandboxId: process.env.CURRENT_SANDBOX_ID ?? null,
      baseSnapshotId: process.env.BASE_SNAPSHOT_ID ?? null,
      nextSandboxUrl: null,
      nextSandboxId: null,
      nextRotationAt: Date.now() + Math.max(30_000, SANDBOX_TIMEOUT_MS - ROTATION_LEAD_MS),
      rotation: {
        inProgress: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        error: null,
      },
    });
  }
}

function decodeResumeState() {
  const encoded = process.env.CHAIN_STATE_B64;
  if (!encoded) {
    return {};
  }

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return {};
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
    baseSnapshotId: input.baseSnapshotId ?? process.env.BASE_SNAPSHOT_ID ?? null,
    nextSandboxUrl: input.nextSandboxUrl ?? null,
    nextSandboxId: input.nextSandboxId ?? null,
    nextRotationAt,
    rotation: {
      inProgress: Boolean(input.rotation?.inProgress),
      lastAttemptAt: input.rotation?.lastAttemptAt ?? null,
      lastSuccessAt: input.rotation?.lastSuccessAt ?? null,
      error: input.rotation?.error ?? null,
    },
  };
}

async function persistState() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function recordHeartbeat(phase = state.rotation.inProgress ? "handoff" : "steady") {
  const now = Date.now();
  const expected = state.lastHeartbeatAt + HEARTBEAT_INTERVAL_MS;
  const driftMs = state.heartbeatCount === 0 ? 0 : now - expected;

  state.lastHeartbeatAt = now;
  state.heartbeatCount += 1;
  state.pulseHistory = [
    ...state.pulseHistory,
    {
      timestamp: now,
      driftMs,
      phase,
    },
  ].slice(-48);

  await persistState();
}

function buildStatusPayload() {
  const now = Date.now();

  return {
    healthy: true,
    chainId: state.chainId,
    generation: state.generation,
    sandboxId: state.currentSandboxId,
    baseSnapshotId: state.baseSnapshotId,
    sandboxStartedAt: state.sandboxStartedAt,
    sandboxUptimeMs: now - state.sandboxStartedAt,
    genesisAt: state.genesisAt,
    chainUptimeMs: now - state.genesisAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    heartbeatCount: state.heartbeatCount,
    nextRotationAt: state.nextRotationAt,
    msUntilRotation: Math.max(0, state.nextRotationAt - now),
    nextSandboxUrl: state.nextSandboxUrl,
    nextSandboxId: state.nextSandboxId,
    rotation: state.rotation,
    pulseHistory: state.pulseHistory,
  };
}

function respondJson(response, payload) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function scheduleRotation() {
  const waitMs = Math.max(5_000, state.nextRotationAt - Date.now());
  clearTimeout(rotationTimer);
  rotationTimer = setTimeout(() => {
    rotateChain("scheduled").catch((error) => {
      console.error("Scheduled rotation failed", error);
    });
  }, waitMs);

  rotationTimer.unref?.();
}

function buildAuthEnv() {
  return authKeys.reduce((env, key) => {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
    return env;
  }, {});
}

async function rotateChain(reason) {
  if (state.rotation.inProgress || !state.baseSnapshotId) {
    return;
  }

  state.rotation.inProgress = true;
  state.rotation.lastAttemptAt = Date.now();
  state.rotation.error = null;
  await recordHeartbeat("handoff");

  try {
    const { Sandbox } = await import("@vercel/sandbox");

    const nextSandbox = await Sandbox.create({
      source: {
        type: "snapshot",
        snapshotId: state.baseSnapshotId,
      },
      runtime: "node24",
      ports: [APP_PORT],
      timeout: SANDBOX_TIMEOUT_MS,
      env: {
        APP_PORT: String(APP_PORT),
        BASE_SNAPSHOT_ID: state.baseSnapshotId,
        SANDBOX_TIMEOUT_MS: String(SANDBOX_TIMEOUT_MS),
        ROTATION_LEAD_MS: String(ROTATION_LEAD_MS),
        HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
        CHAIN_ID: state.chainId,
        GENESIS_AT: String(state.genesisAt),
        GENERATION: String(state.generation + 1),
        REPO_ROOT,
        ...buildAuthEnv(),
      },
    });

    const resumeState = Buffer.from(
      JSON.stringify({
        chainId: state.chainId,
        generation: state.generation + 1,
        genesisAt: state.genesisAt,
        heartbeatCount: state.heartbeatCount,
        pulseHistory: state.pulseHistory.slice(-24),
      }),
      "utf8",
    ).toString("base64url");

    await nextSandbox.runCommand({
      cmd: "node",
      args: ["sandbox-site/server.mjs"],
      cwd: REPO_ROOT,
      detached: true,
      env: {
        CURRENT_SANDBOX_ID: nextSandbox.sandboxId,
        CHAIN_STATE_B64: resumeState,
      },
    });

    const nextSandboxUrl = normalizeSandboxUrl(nextSandbox.domain(APP_PORT));
    await waitForReady(nextSandboxUrl);

    state.nextSandboxId = nextSandbox.sandboxId;
    state.nextSandboxUrl = nextSandboxUrl;
    state.rotation.inProgress = false;
    state.rotation.lastSuccessAt = Date.now();
    state.rotation.error = null;
    state.pulseHistory = [
      ...state.pulseHistory,
      {
        timestamp: Date.now(),
        driftMs: 0,
        phase: "recovered",
      },
    ].slice(-48);

    await persistState();

    clearTimeout(stopTimer);
    stopTimer = setTimeout(async () => {
      try {
        const currentSandboxId = state.currentSandboxId;
        if (!currentSandboxId) {
          process.exit(0);
          return;
        }

        const currentSandbox = await Sandbox.get({ sandboxId: currentSandboxId });
        await currentSandbox.stop();
      } catch (error) {
        console.error("Could not stop the previous sandbox", error);
      }
    }, HANDOFF_REDIRECT_GRACE_MS);

    stopTimer.unref?.();
    console.log(`Handoff ${reason} -> ${nextSandboxUrl}`);
  } catch (error) {
    state.rotation.inProgress = false;
    state.rotation.error = error instanceof Error ? error.message : "Rotation failed.";
    await persistState();
    scheduleRotation();
  }
}

async function waitForReady(url) {
  let lastError = null;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/status`, {
        signal: AbortSignal.timeout(4_000),
        cache: "no-store",
      });

      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw lastError instanceof Error ? lastError : new Error("Next sandbox did not become ready in time.");
}

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
      const height = 26 + Math.min(Math.abs(pulse.driftMs), 140) / 2;
      return `<span class="pulse-bar pulse-${pulse.phase}" style="height:${height}px"></span>`;
    })
    .join("");
}

function renderPage(status) {
  const sandboxUptime = formatDuration(status.sandboxUptimeMs);
  const chainUptime = formatDuration(status.chainUptimeMs);
  const rotationCountdown = formatDuration(status.msUntilRotation);
  const redirectBanner = status.nextSandboxUrl
    ? `
      <div class="redirect-banner">
        <strong>Fresh sandbox ready.</strong>
        <span>This page will hand visitors to the next generation shortly.</span>
        <a href="${status.nextSandboxUrl}">Jump now</a>
      </div>
    `
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Eternal Sandbox</title>
    <style>
      :root {
        --bg: #07131e;
        --panel: rgba(10, 24, 38, 0.84);
        --panel-strong: rgba(13, 31, 47, 0.96);
        --line: rgba(146, 187, 198, 0.14);
        --text: #e6f2ef;
        --muted: #97b0b8;
        --accent-coral: #ff8057;
        --accent-cyan: #67d8d1;
        --accent-gold: #ffcc73;
        --good: #90f0b1;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        font-family: "Avenir Next", "Segoe UI", "Trebuchet MS", sans-serif;
        background:
          radial-gradient(circle at 15% 15%, rgba(255, 128, 87, 0.18), transparent 20%),
          radial-gradient(circle at 85% 12%, rgba(103, 216, 209, 0.18), transparent 18%),
          linear-gradient(180deg, #0a1622 0%, #07131e 62%, #050b12 100%);
      }

      main {
        width: min(1100px, calc(100% - 2rem));
        margin: 0 auto;
        padding: 2rem 0 4rem;
      }

      .hero,
      .metric,
      .detail {
        border: 1px solid var(--line);
        border-radius: 28px;
        background: linear-gradient(180deg, rgba(16, 34, 51, 0.94), rgba(10, 21, 31, 0.88));
        box-shadow: 0 24px 100px rgba(1, 9, 17, 0.42);
        backdrop-filter: blur(18px);
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.82fr);
        gap: 1.5rem;
        padding: 2rem;
        overflow: hidden;
        position: relative;
      }

      .hero::after {
        content: "";
        position: absolute;
        inset: auto -10% -28% auto;
        width: 300px;
        height: 300px;
        background: radial-gradient(circle, rgba(103, 216, 209, 0.24), transparent 66%);
      }

      .eyebrow {
        margin: 0 0 0.75rem;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        font-size: 0.82rem;
        color: var(--accent-gold);
      }

      h1 {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: clamp(3rem, 8vw, 5rem);
        line-height: 0.92;
      }

      .lede,
      .meta,
      .copy,
      .note {
        margin: 1.1rem 0 0;
        color: var(--muted);
        line-height: 1.7;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.45rem 0.8rem;
        border-radius: 999px;
        width: fit-content;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        font-size: 0.78rem;
        font-weight: 700;
        background: var(--good);
        color: #0a2a17;
      }

      .hero-panel {
        display: grid;
        gap: 0.9rem;
        align-content: start;
        border-radius: 22px;
        padding: 1.4rem;
        background: linear-gradient(180deg, rgba(12, 26, 39, 0.94), rgba(8, 16, 24, 0.88));
        position: relative;
        z-index: 1;
      }

      .hero-panel a {
        display: inline-flex;
        width: fit-content;
        align-items: center;
        justify-content: center;
        padding: 0.9rem 1.15rem;
        border-radius: 16px;
        text-decoration: none;
        color: inherit;
        background: linear-gradient(135deg, rgba(255, 128, 87, 0.18), rgba(103, 216, 209, 0.18));
        border: 1px solid rgba(255,255,255,0.08);
        font-weight: 600;
      }

      .grid,
      .details {
        display: grid;
        gap: 1rem;
        margin-top: 1.25rem;
      }

      .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .details { grid-template-columns: repeat(2, minmax(0, 1fr)); }

      .metric,
      .detail { padding: 1.5rem; }

      .metric-label,
      .detail-title {
        margin: 0;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        font-size: 0.88rem;
        color: rgba(230, 242, 239, 0.72);
      }

      .metric-value {
        margin: 1rem 0 0.45rem;
        font-size: clamp(2rem, 5vw, 3.25rem);
        line-height: 1;
        font-family: "IBM Plex Mono", "Menlo", monospace;
      }

      .detail-list {
        margin: 1rem 0 0;
        display: grid;
        gap: 0.85rem;
      }

      .detail-list strong {
        display: block;
        margin-bottom: 0.1rem;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        font-size: 0.8rem;
        color: rgba(230, 242, 239, 0.68);
      }

      .pulse-strip {
        display: flex;
        align-items: end;
        gap: 0.35rem;
        min-height: 120px;
        margin-top: 1rem;
      }

      .pulse-bar {
        width: calc((100% - 23 * 0.35rem) / 24);
        min-width: 8px;
        border-radius: 999px 999px 12px 12px;
        background: rgba(255, 255, 255, 0.14);
      }

      .pulse-steady { background: linear-gradient(180deg, rgba(103,216,209,0.95), rgba(103,216,209,0.24)); }
      .pulse-handoff { background: linear-gradient(180deg, rgba(255,204,115,0.95), rgba(255,204,115,0.24)); }
      .pulse-recovered { background: linear-gradient(180deg, rgba(255,128,87,0.95), rgba(255,128,87,0.24)); }

      .redirect-banner {
        display: grid;
        gap: 0.45rem;
        margin: 1.25rem 0 0;
        padding: 1rem 1.1rem;
        border-radius: 18px;
        background: rgba(255, 204, 115, 0.12);
        border: 1px solid rgba(255, 204, 115, 0.18);
      }

      .redirect-banner a {
        width: fit-content;
        color: var(--text);
      }

      @media (max-width: 860px) {
        main { width: min(100% - 1.1rem, 1100px); padding-top: 1.1rem; }
        .hero, .grid, .details { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">Generation ${status.generation}</p>
          <h1>This sandbox has been alive for <span id="sandbox-counter">${sandboxUptime}</span></h1>
          <p class="lede">
            You are looking at the page served directly from the current Vercel Sandbox. It keeps its own heartbeat,
            tracks the full chain age, and prepares a fresh snapshot-backed sibling before this sandbox times out.
          </p>
          ${redirectBanner}
        </div>
        <aside class="hero-panel">
          <span class="pill">healthy</span>
          <p class="meta">Sandbox ID: ${status.sandboxId ?? "unknown"}</p>
          <p class="meta">Base snapshot: ${status.baseSnapshotId ?? "unknown"}</p>
          <p class="meta">Next rotation in ${rotationCountdown}</p>
          <a href="/status">Open live JSON status</a>
        </aside>
      </section>

      <section class="grid">
        <article class="metric">
          <p class="metric-label">Sandbox uptime</p>
          <p class="metric-value" id="sandbox-uptime">${sandboxUptime}</p>
          <p class="note">Fresh on every generation.</p>
        </article>
        <article class="metric">
          <p class="metric-label">Chain uptime</p>
          <p class="metric-value" id="chain-uptime">${chainUptime}</p>
          <p class="note">Persists across handoffs.</p>
        </article>
        <article class="metric">
          <p class="metric-label">Next handoff</p>
          <p class="metric-value" id="rotation-countdown">${rotationCountdown}</p>
          <p class="note">A new sandbox wakes before the timeout.</p>
        </article>
      </section>

      <section class="details">
        <article class="detail">
          <p class="detail-title">Runtime details</p>
          <div class="detail-list">
            <div><strong>Chain started</strong>${formatClock(status.genesisAt)}</div>
            <div><strong>Last heartbeat</strong><span id="last-heartbeat">${formatClock(status.lastHeartbeatAt)}</span></div>
            <div><strong>Heartbeat count</strong><span id="heartbeat-count">${status.heartbeatCount}</span></div>
            <div><strong>Rotation state</strong><span id="rotation-state">${status.rotation.inProgress ? "Preparing successor" : "Steady"}</span></div>
            <div><strong>Rotation error</strong><span id="rotation-error">${status.rotation.error ?? "None"}</span></div>
          </div>
        </article>
        <article class="detail">
          <p class="detail-title">Pulse strip</p>
          <div class="pulse-strip" id="pulse-strip">${renderPulseBars(status)}</div>
          <p class="copy">Each bar marks one internal heartbeat from this sandbox process.</p>
        </article>
      </section>
    </main>

    <script>
      const initialStatus = ${JSON.stringify(status)};
      let latestStatus = initialStatus;

      function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
        const seconds = String(totalSeconds % 60).padStart(2, "0");
        return hours + ":" + minutes + ":" + seconds;
      }

      function formatClock(timestamp) {
        return new Intl.DateTimeFormat("en", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          month: "short",
          day: "2-digit"
        }).format(timestamp);
      }

      function renderCounters() {
        const now = Date.now();
        document.getElementById("sandbox-counter").textContent = formatDuration(now - latestStatus.sandboxStartedAt);
        document.getElementById("sandbox-uptime").textContent = formatDuration(now - latestStatus.sandboxStartedAt);
        document.getElementById("chain-uptime").textContent = formatDuration(now - latestStatus.genesisAt);
        document.getElementById("rotation-countdown").textContent = formatDuration(Math.max(0, latestStatus.nextRotationAt - now));
      }

      function renderPulseBars(history) {
        const strip = document.getElementById("pulse-strip");
        strip.innerHTML = history.slice(-24).map((pulse) => {
          const height = 26 + Math.min(Math.abs(pulse.driftMs), 140) / 2;
          return '<span class="pulse-bar pulse-' + pulse.phase + '" style="height:' + height + 'px"></span>';
        }).join("");
      }

      async function refreshStatus() {
        try {
          const response = await fetch("/status", { cache: "no-store" });
          if (!response.ok) {
            return;
          }

          latestStatus = await response.json();
          document.getElementById("last-heartbeat").textContent = formatClock(latestStatus.lastHeartbeatAt);
          document.getElementById("heartbeat-count").textContent = String(latestStatus.heartbeatCount);
          document.getElementById("rotation-state").textContent = latestStatus.rotation.inProgress ? "Preparing successor" : "Steady";
          document.getElementById("rotation-error").textContent = latestStatus.rotation.error || "None";
          renderPulseBars(latestStatus.pulseHistory || []);

          if (latestStatus.nextSandboxUrl && window.location.href !== latestStatus.nextSandboxUrl + "/") {
            setTimeout(() => {
              window.location.href = latestStatus.nextSandboxUrl;
            }, 8000);
          }
        } catch {
          // ignore refresh failures
        }
      }

      renderCounters();
      setInterval(renderCounters, 1000);
      refreshStatus();
      setInterval(refreshStatus, 15000);
    </script>
  </body>
</html>`;
}
