export type PulsePoint = {
  timestamp: number;
  driftMs: number;
  phase: "steady" | "handoff" | "recovered";
};

export type SandboxRuntimeStatus = {
  healthy: boolean;
  chainId: string;
  generation: number;
  sandboxId: string | null;
  baseSnapshotId: string | null;
  sandboxStartedAt: number;
  sandboxUptimeMs: number;
  genesisAt: number;
  chainUptimeMs: number;
  lastHeartbeatAt: number;
  heartbeatCount: number;
  nextRotationAt: number;
  msUntilRotation: number;
  nextSandboxUrl: string | null;
  nextSandboxId: string | null;
  rotation: {
    inProgress: boolean;
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    error: string | null;
  };
  pulseHistory: PulsePoint[];
};

export type ChainCandidate = {
  sandboxId: string;
  sandboxUrl: string;
  checkedAt: string;
  summaryStatus: string | null;
  status: SandboxRuntimeStatus;
};

export type ChainStatusResponse = {
  healthy: boolean;
  checkedAt: string;
  note: string | null;
  current: ChainCandidate | null;
  candidates: ChainCandidate[];
};

export type BootstrapResponse = {
  launched: boolean;
  checkedAt: string;
  snapshotId: string;
  sandboxId: string;
  sandboxUrl: string;
  repoRoot: string;
  status: SandboxRuntimeStatus;
};
