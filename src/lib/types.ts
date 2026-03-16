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
  sourceSnapshotId: string | null;
  sandboxStartedAt: number;
  sandboxUptimeMs: number;
  genesisAt: number;
  chainUptimeMs: number;
  lastHeartbeatAt: number;
  heartbeatCount: number;
  nextRotationAt: number;
  msUntilRotation: number;
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

export type RotateResponse = {
  rotated: boolean;
  checkedAt: string;
  note: string | null;
  previousSandboxId: string | null;
  previousSnapshotId: string | null;
  newSandboxId: string | null;
  newSandboxUrl: string | null;
  newSnapshotId: string | null;
  generation: number;
  prunedSnapshots: string[];
};
