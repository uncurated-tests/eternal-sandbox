import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Sandbox, Snapshot } from "@vercel/sandbox";

import type {
  BootstrapResponse,
  ChainCandidate,
  ChainStatusResponse,
  RotateResponse,
  SandboxRuntimeStatus,
} from "@/lib/types";

const SANDBOX_PORT = Number(process.env.SANDBOX_PORT ?? 3000);
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 4 * 60 * 60 * 1000);
const ROTATION_LEAD_MS = Number(process.env.ROTATION_LEAD_MS ?? 5 * 60 * 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 15 * 1000);
const BUILDER_TIMEOUT_MS = Number(process.env.BUILDER_TIMEOUT_MS ?? 10 * 60 * 1000);
const STATUS_POLL_ATTEMPTS = Number(process.env.STATUS_POLL_ATTEMPTS ?? 30);
const STATUS_POLL_DELAY_MS = Number(process.env.STATUS_POLL_DELAY_MS ?? 2000);
const SNAPSHOT_RETAIN_COUNT = 3;
const GIT_SOURCE_URL =
  process.env.SANDBOX_REPO_URL ?? "https://github.com/uncurated-tests/eternal-sandbox.git";

const LOCAL_SANDBOX_DIR = path.join(process.cwd(), "sandbox-site");

type ListedSandbox = {
  sandboxId?: string;
  id?: string;
  status?: string;
};

type SnapshotSummary = {
  id: string;
  status: string;
  createdAt: number;
  sizeBytes: number;
};

// ── helpers ──

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSandboxId(candidate: ListedSandbox) {
  return candidate.sandboxId ?? candidate.id ?? null;
}

function normalizeSandboxUrl(url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
}

function getAuthEnv() {
  const env: Record<string, string> = {};
  const passthroughKeys = [
    "VERCEL_OIDC_TOKEN",
    "VERCEL_PROJECT_ID",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "VERCEL_URL",
  ];

  for (const key of passthroughKeys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_ACCESS_TOKEN;
  if (token) {
    env.VERCEL_TOKEN = token;
  }

  return env;
}

function buildRuntimeEnv(input: {
  sourceSnapshotId: string;
  generation: number;
  genesisAt: number;
  chainId: string;
  repoRoot: string;
}) {
  return {
    APP_PORT: String(SANDBOX_PORT),
    SOURCE_SNAPSHOT_ID: input.sourceSnapshotId,
    SANDBOX_TIMEOUT_MS: String(SANDBOX_TIMEOUT_MS),
    ROTATION_LEAD_MS: String(ROTATION_LEAD_MS),
    HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
    CHAIN_ID: input.chainId,
    GENESIS_AT: String(input.genesisAt),
    GENERATION: String(input.generation),
    REPO_ROOT: input.repoRoot,
    ...getAuthEnv(),
  };
}

// ── snapshot helpers ──

async function listProjectSnapshots(): Promise<SnapshotSummary[]> {
  const result = await Snapshot.list({ limit: 20 });
  const raw = (
    (result as unknown as { json?: { snapshots?: SnapshotSummary[] } }).json ?? {}
  ).snapshots ?? [];
  return raw.filter((s) => s.status === "created").sort((a, b) => b.createdAt - a.createdAt);
}

async function getLatestSnapshot(): Promise<string | null> {
  const snapshots = await listProjectSnapshots();
  return snapshots[0]?.id ?? null;
}

async function pruneOldSnapshots(keep: number = SNAPSHOT_RETAIN_COUNT): Promise<string[]> {
  const snapshots = await listProjectSnapshots();
  const toDelete = snapshots.slice(keep);
  const deleted: string[] = [];

  for (const snap of toDelete) {
    try {
      const full = await Snapshot.get({ snapshotId: snap.id });
      await full.delete();
      deleted.push(snap.id);
    } catch {
      // ignore individual delete failures
    }
  }

  return deleted;
}

// ── sandbox file sync ──

async function collectBundledSandboxFiles(dir: string): Promise<Array<{ path: string; content: Buffer }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: Array<{ path: string; content: Buffer }> = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "runtime-state.json") {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectBundledSandboxFiles(absolutePath)));
      continue;
    }

    files.push({
      path: path.relative(LOCAL_SANDBOX_DIR, absolutePath).split(path.sep).join("/"),
      content: await fs.readFile(absolutePath),
    });
  }

  return files;
}

async function syncBundledSandboxSite(sandbox: Sandbox, repoRoot: string) {
  const files = await collectBundledSandboxFiles(LOCAL_SANDBOX_DIR);

  if (!files.length) {
    return;
  }

  await sandbox.writeFiles(
    files.map((file) => ({
      path: `${repoRoot}/sandbox-site/${file.path}`,
      content: file.content,
    })),
  );
}

// ── sandbox probing ──

async function fetchStatus(url: string) {
  const response = await fetch(`${url}/status`, {
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });

  if (!response.ok) {
    throw new Error(`Status probe failed with ${response.status}.`);
  }

  return (await response.json()) as SandboxRuntimeStatus;
}

async function waitForStatus(url: string) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS; attempt += 1) {
    try {
      return await fetchStatus(url);
    } catch (error) {
      lastError = error;
      await sleep(STATUS_POLL_DELAY_MS);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out while waiting for the sandbox site to become ready.");
}

async function probeSandbox(summary: ListedSandbox) {
  const sandboxId = getSandboxId(summary);
  if (!sandboxId) {
    return null;
  }

  try {
    const sandbox = await Sandbox.get({ sandboxId });
    const sandboxUrl = normalizeSandboxUrl(sandbox.domain(SANDBOX_PORT));
    const status = await fetchStatus(sandboxUrl);

    return {
      sandboxId,
      sandboxUrl,
      checkedAt: new Date().toISOString(),
      summaryStatus: summary.status ?? null,
      status,
    } satisfies ChainCandidate;
  } catch {
    return null;
  }
}

function compareCandidates(a: ChainCandidate, b: ChainCandidate) {
  if (a.status.generation !== b.status.generation) {
    return b.status.generation - a.status.generation;
  }

  if (a.status.sandboxStartedAt !== b.status.sandboxStartedAt) {
    return b.status.sandboxStartedAt - a.status.sandboxStartedAt;
  }

  return b.status.lastHeartbeatAt - a.status.lastHeartbeatAt;
}

// ── public: discover ──

export async function discoverCurrentChain(): Promise<ChainStatusResponse> {
  try {
    const listed = await Sandbox.list({ limit: 24 });
    const sandboxes = (((listed as unknown as { json?: { sandboxes?: ListedSandbox[] } }).json ?? {})
      .sandboxes ?? []) as ListedSandbox[];

    const running = sandboxes.filter((candidate) => {
      const sandboxId = getSandboxId(candidate);
      const status = candidate.status?.toLowerCase();
      return Boolean(sandboxId) && (status === "running" || status === "pending");
    });

    const probed = await Promise.all(running.map((candidate) => probeSandbox(candidate)));
    const candidates = probed.filter((candidate): candidate is ChainCandidate => Boolean(candidate));
    candidates.sort(compareCandidates);

    return {
      healthy: Boolean(candidates[0]?.status.healthy),
      checkedAt: new Date().toISOString(),
      note: candidates.length ? null : "No healthy sandbox chain is running yet.",
      current: candidates[0] ?? null,
      candidates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not query the sandbox API.";
    return {
      healthy: false,
      checkedAt: new Date().toISOString(),
      note: message,
      current: null,
      candidates: [],
    };
  }
}

// ── builder: initial base snapshot ──

async function resolveRepoRoot(sandbox: Sandbox) {
  const resolver = await sandbox.runCommand({
    cmd: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        "const candidates = ['/vercel/sandbox', '/vercel/sandbox/repo'];",
        "const match = candidates.find((dir) => fs.existsSync(`${dir}/sandbox-site/package.json`));",
        "if (!match) { process.exit(1); }",
        "process.stdout.write(match);",
      ].join(" "),
    ],
  });

  if (resolver.exitCode !== 0) {
    throw new Error("Could not locate sandbox-site inside the builder sandbox.");
  }

  return (await resolver.stdout()).trim();
}

async function createBaseSnapshot(): Promise<{ snapshotId: string; repoRoot: string }> {
  const builder = await Sandbox.create({
    runtime: "node24",
    source: {
      type: "git",
      url: GIT_SOURCE_URL,
      depth: 1,
    },
    timeout: BUILDER_TIMEOUT_MS,
    env: getAuthEnv(),
  });

  const repoRoot = await resolveRepoRoot(builder);
  await syncBundledSandboxSite(builder, repoRoot);

  const install = await builder.runCommand({
    cmd: "npm",
    args: ["install", "--omit=dev"],
    cwd: `${repoRoot}/sandbox-site`,
  });

  if (install.exitCode !== 0) {
    const output = await install.output("both");
    throw new Error(`Sandbox dependency install failed.\n${output}`);
  }

  const snapshot = await builder.snapshot({ expiration: 0 });

  return {
    snapshotId: snapshot.snapshotId,
    repoRoot,
  };
}

// ── launch from any snapshot ──

async function launchFromSnapshot(
  snapshotId: string,
  overrides?: { generation?: number; genesisAt?: number; chainId?: string; repoRoot?: string },
): Promise<BootstrapResponse> {
  const chainId = overrides?.chainId ?? randomUUID();
  const genesisAt = overrides?.genesisAt ?? Date.now();
  const generation = overrides?.generation ?? 1;
  const repoRoot = overrides?.repoRoot ?? "/vercel/sandbox";

  const liveSandbox = await Sandbox.create({
    source: {
      type: "snapshot",
      snapshotId,
    },
    runtime: "node24",
    ports: [SANDBOX_PORT],
    timeout: SANDBOX_TIMEOUT_MS,
    env: buildRuntimeEnv({
      sourceSnapshotId: snapshotId,
      generation,
      genesisAt,
      chainId,
      repoRoot,
    }),
  });

  await liveSandbox.runCommand({
    cmd: "node",
    args: ["sandbox-site/server.mjs"],
    cwd: repoRoot,
    detached: true,
    env: {
      CURRENT_SANDBOX_ID: liveSandbox.sandboxId,
    },
  });

  const sandboxUrl = normalizeSandboxUrl(liveSandbox.domain(SANDBOX_PORT));
  const status = await waitForStatus(sandboxUrl);

  return {
    launched: true,
    checkedAt: new Date().toISOString(),
    snapshotId,
    sandboxId: liveSandbox.sandboxId,
    sandboxUrl,
    repoRoot,
    status,
  };
}

// ── public: bootstrap ──

export async function bootstrapChain(): Promise<BootstrapResponse> {
  const current = await discoverCurrentChain();
  if (current.healthy && current.current) {
    return {
      launched: false,
      checkedAt: new Date().toISOString(),
      snapshotId: current.current.status.sourceSnapshotId ?? "unknown",
      sandboxId: current.current.sandboxId,
      sandboxUrl: current.current.sandboxUrl,
      repoRoot: "/vercel/sandbox",
      status: current.current.status,
    };
  }

  // Try launching from latest existing snapshot
  const latestSnapshotId = await getLatestSnapshot();
  if (latestSnapshotId) {
    return launchFromSnapshot(latestSnapshotId);
  }

  // No snapshots at all — create the initial base snapshot
  const base = await createBaseSnapshot();
  return launchFromSnapshot(base.snapshotId, { repoRoot: base.repoRoot });
}

// ── public: rotate ──

export async function rotateChain(): Promise<RotateResponse> {
  const chain = await discoverCurrentChain();

  if (!chain.healthy || !chain.current) {
    return {
      rotated: false,
      checkedAt: new Date().toISOString(),
      note: "No healthy sandbox to rotate. Call /api/bootstrap first.",
      previousSandboxId: null,
      previousSnapshotId: null,
      newSandboxId: null,
      newSandboxUrl: null,
      newSnapshotId: null,
      generation: 0,
      prunedSnapshots: [],
    };
  }

  const current = chain.current;
  const prevStatus = current.status;

  // Check if inside handoff window
  if (prevStatus.msUntilRotation > ROTATION_LEAD_MS) {
    return {
      rotated: false,
      checkedAt: new Date().toISOString(),
      note: `Not in handoff window yet. ${Math.round(prevStatus.msUntilRotation / 60_000)}m remaining.`,
      previousSandboxId: current.sandboxId,
      previousSnapshotId: prevStatus.sourceSnapshotId,
      newSandboxId: null,
      newSandboxUrl: null,
      newSnapshotId: null,
      generation: prevStatus.generation,
      prunedSnapshots: [],
    };
  }

  // Snapshot the live sandbox (this stops it)
  const liveSandbox = await Sandbox.get({ sandboxId: current.sandboxId });
  const newSnapshot = await liveSandbox.snapshot({ expiration: 0 });

  // Launch from the fresh snapshot
  const nextGeneration = prevStatus.generation + 1;
  const launched = await launchFromSnapshot(newSnapshot.snapshotId, {
    generation: nextGeneration,
    genesisAt: prevStatus.genesisAt,
    chainId: prevStatus.chainId,
  });

  // Prune old snapshots
  const pruned = await pruneOldSnapshots();

  return {
    rotated: true,
    checkedAt: new Date().toISOString(),
    note: null,
    previousSandboxId: current.sandboxId,
    previousSnapshotId: prevStatus.sourceSnapshotId,
    newSandboxId: launched.sandboxId,
    newSandboxUrl: launched.sandboxUrl,
    newSnapshotId: newSnapshot.snapshotId,
    generation: nextGeneration,
    prunedSnapshots: pruned,
  };
}
