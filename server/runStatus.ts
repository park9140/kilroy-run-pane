import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ResolvedRunArtifactStatus = "running" | "completed" | "failed" | "interrupted";

export interface FailedStageInfo {
  nodeId: string;
  status: string;
  failureReason?: string;
}

export interface RunArtifactStatus {
  status: ResolvedRunArtifactStatus;
  failureReason?: string;
  finishedAt?: string;
  failedStage?: FailedStageInfo;
}

type JsonRecord = Record<string, unknown>;

const FAILED_STAGE_STATUSES = new Set(["fail", "failed", "work_failed"]);

async function readJsonFile(path: string): Promise<JsonRecord | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as JsonRecord;
  } catch {
    return null;
  }
}

async function readFailedTopLevelStage(runDir: string): Promise<FailedStageInfo | undefined> {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const stageDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const nodeId of stageDirs) {
    const statusJson = await readJsonFile(join(runDir, nodeId, "status.json"));
    if (!statusJson) {
      continue;
    }

    const rawStatus = String(statusJson.status ?? "").trim().toLowerCase();
    if (!FAILED_STAGE_STATUSES.has(rawStatus)) {
      continue;
    }

    const failureReason = typeof statusJson.failure_reason === "string"
      ? statusJson.failure_reason
      : undefined;

    return {
      nodeId,
      status: rawStatus,
      failureReason,
    };
  }

  return undefined;
}

function readFinalStatus(finalJson: JsonRecord | null): Omit<RunArtifactStatus, "failedStage"> | null {
  if (!finalJson) {
    return null;
  }

  const rawStatus = String(finalJson.status ?? "").trim().toLowerCase();
  const finishedAt = typeof finalJson.timestamp === "string" ? finalJson.timestamp : undefined;
  const failureReason = typeof finalJson.failure_reason === "string"
    ? finalJson.failure_reason
    : undefined;

  if (rawStatus === "success") {
    return {
      status: "completed",
      finishedAt,
      failureReason,
    };
  }

  if (rawStatus === "fail" || rawStatus === "failed") {
    return {
      status: "failed",
      finishedAt,
      failureReason,
    };
  }

  if (rawStatus === "interrupted") {
    return {
      status: "interrupted",
      finishedAt,
      failureReason,
    };
  }

  return null;
}

function readLiveStatus(liveJson: JsonRecord | null): Omit<RunArtifactStatus, "failedStage"> | null {
  if (!liveJson) {
    return null;
  }

  const rawState = String(liveJson.event ?? liveJson.status ?? "").trim().toLowerCase();
  const finishedAt = typeof liveJson.ts === "string" ? liveJson.ts : undefined;
  const failureReason = typeof liveJson.failure_reason === "string"
    ? liveJson.failure_reason
    : undefined;

  if (rawState === "completed") {
    return {
      status: "completed",
      finishedAt,
      failureReason,
    };
  }

  if (rawState === "failed" || rawState === "fail") {
    return {
      status: "failed",
      finishedAt,
      failureReason,
    };
  }

  if (rawState === "interrupted") {
    return {
      status: "interrupted",
      finishedAt,
      failureReason,
    };
  }

  return null;
}

export async function readRunArtifactStatus(runDir: string): Promise<RunArtifactStatus> {
  const [failedStage, finalStatus, liveStatus] = await Promise.all([
    readFailedTopLevelStage(runDir),
    readJsonFile(join(runDir, "final.json")).then(readFinalStatus),
    readJsonFile(join(runDir, "live.json")).then(readLiveStatus),
  ]);

  if (failedStage) {
    return {
      status: "failed",
      failureReason: failedStage.failureReason ?? finalStatus?.failureReason ?? liveStatus?.failureReason,
      finishedAt: finalStatus?.finishedAt ?? liveStatus?.finishedAt,
      failedStage,
    };
  }

  if (finalStatus) {
    return finalStatus;
  }

  if (liveStatus) {
    return liveStatus;
  }

  return { status: "running" };
}
