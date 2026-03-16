import { randomUUID } from "node:crypto";

import { Sandbox } from "@vercel/sandbox";

import type {
  BootstrapResponse,
  ChainCandidate,
  ChainStatusResponse,
  SandboxRuntimeStatus,
} from "@/lib/types";

const SANDBOX_PORT = Number(process.env.SANDBOX_PORT ?? 3000);
const SANDBOX_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 40 * 60 * 1000);
const ROTATION_LEAD_MS = Number(process.env.ROTATION_LEAD_MS ?? 5 * 60 * 1000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 15 * 1000);
const BUILDER_TIMEOUT_MS = Number(process.env.BUILDER_TIMEOUT_MS ?? 10 * 60 * 1000);
const STATUS_POLL_ATTEMPTS = Number(process.env.STATUS_POLL_ATTEMPTS ?? 30);
const STATUS_POLL_DELAY_MS = Number(process.env.STATUS_POLL_DELAY_MS ?? 2000);
const GIT_SOURCE_URL =
  process.env.SANDBOX_REPO_URL ?? "https://github.com/uncurated-tests/eternal-sandbox.git";

type ListedSandbox = {
  sandboxId?: string;
  id?: string;
  status?: string;
};

type SnapshotBootstrap = {
  snapshotId: string;
  repoRoot: string;
};

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
  baseSnapshotId: string;
  generation: number;
  genesisAt: number;
  chainId: string;
  repoRoot: string;
}) {
  return {
    APP_PORT: String(SANDBOX_PORT),
    BASE_SNAPSHOT_ID: input.baseSnapshotId,
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

async function createBaseSnapshot(): Promise<SnapshotBootstrap> {
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

async function launchFromSnapshot(input: SnapshotBootstrap): Promise<BootstrapResponse> {
  const chainId = randomUUID();
  const genesisAt = Date.now();

  const liveSandbox = await Sandbox.create({
    source: {
      type: "snapshot",
      snapshotId: input.snapshotId,
    },
    runtime: "node24",
    ports: [SANDBOX_PORT],
    timeout: SANDBOX_TIMEOUT_MS,
    env: buildRuntimeEnv({
      baseSnapshotId: input.snapshotId,
      generation: 1,
      genesisAt,
      chainId,
      repoRoot: input.repoRoot,
    }),
  });

  await liveSandbox.runCommand({
    cmd: "node",
    args: ["sandbox-site/server.mjs"],
    cwd: input.repoRoot,
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
    snapshotId: input.snapshotId,
    sandboxId: liveSandbox.sandboxId,
    sandboxUrl,
    repoRoot: input.repoRoot,
    status,
  };
}

export async function bootstrapChain(): Promise<BootstrapResponse> {
  const current = await discoverCurrentChain();
  if (current.healthy && current.current) {
    return {
      launched: false,
      checkedAt: new Date().toISOString(),
      snapshotId: current.current.status.baseSnapshotId ?? "unknown",
      sandboxId: current.current.sandboxId,
      sandboxUrl: current.current.sandboxUrl,
      repoRoot: process.env.REPO_ROOT ?? "/vercel/sandbox",
      status: current.current.status,
    };
  }

  const snapshot = await createBaseSnapshot();
  return launchFromSnapshot(snapshot);
}
