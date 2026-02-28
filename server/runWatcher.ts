import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import chokidar, { type FSWatcher } from "chokidar";
import { checkContainerAlive } from "./pidCheck.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RunStatus = "pending" | "executing" | "completed" | "failed" | "stopped" | "interrupted";
export type ComputedStatus = "executing" | "stalled" | "completed" | "failed" | "interrupted" | "unknown";

export interface RunRecord {
  id: string;
  repo?: string;
  dot_file?: string;
  status?: RunStatus;
  current_node?: string;
  container_id?: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  last_heartbeat?: string;
  failure_reason?: string;
  attractor_run_id?: string;
  attractor_logs_root?: string;
  has_checkpoint?: boolean;
  params?: Record<string, string>;
  artifacts?: string[];
  annotations?: unknown[];
  notifications?: unknown[];
  notes?: unknown[];
  source?: string;
  completed_nodes?: string[];
}

export interface StageInfo {
  node_id: string;
  status: string;
  failure_reason?: string;
  context_updates?: Record<string, unknown>;
  started_at?: string;
  finished_at?: string;
}

export interface VisitedStage {
  node_id: string;
  attempt: number;
  status: "pass" | "fail" | "running";
  started_at: string;
  finished_at?: string;
  duration_s?: number;
  failure_reason?: string;
  fan_out_node?: string;
  branch_key?: string;
  stage_path?: string;
  restartIndex?: number; // 0 = root run, 1 = restart-1, N = restart-N
}

export interface CycleInfo {
  failingNodeId: string;
  retryTargetNodeId?: string;  // parsed from DOT graph[retry_target=...]
  signature: string;
  signatureCount: number;
  signatureLimit: number;
  isBreaker: boolean;
}

export interface RunState {
  run: RunRecord;
  containerAlive: boolean;
  computedStatus: ComputedStatus;
  lastChecked: string;
  dot?: string;
  stages?: StageInfo[];
  stageHistory?: VisitedStage[];
  cycleInfo?: CycleInfo;
  restartCount?: number; // number of loop_restart cycles completed
  worktreePath?: string; // absolute path to the run's git worktree
  format: "kilroy-dash" | "attractor";
}

function deriveComputedStatus(run: RunRecord, containerAlive: boolean): ComputedStatus {
  switch (run.status) {
    case "completed": return "completed";
    case "failed": case "stopped": return "failed";
    case "interrupted": return "interrupted";
    case "executing": return containerAlive ? "executing" : "stalled";
    default: return "unknown";
  }
}

// Check if a PID is alive on the host
async function checkPidAlive(pid: number): Promise<boolean> {
  try {
    await execFileAsync("kill", ["-0", String(pid)], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Kilroy-dash sync format (run.json) ──────────────────────────────────────

async function readKilroyDashFormat(runDir: string): Promise<RunState | null> {
  try {
    const raw = await readFile(join(runDir, "run.json"), "utf8");
    const run: RunRecord = JSON.parse(raw);
    const containerId = run.container_id ?? "";
    const containerAlive = run.status === "executing" && containerId
      ? await checkContainerAlive(containerId)
      : false;
    return {
      run,
      containerAlive,
      computedStatus: deriveComputedStatus(run, containerAlive),
      lastChecked: new Date().toISOString(),
      format: "kilroy-dash",
    };
  } catch {
    return null;
  }
}

// ─── Raw attractor format (manifest.json + checkpoint.json + final.json) ────

/** Follow loop_restart events in progress.ndjson to build the ordered list of
 *  all log-root directories for this run: [runDir, restart-1, restart-2, ...].
 */
async function walkRestartChain(rootDir: string): Promise<string[]> {
  const dirs = [rootDir];
  let current = rootDir;
  for (let i = 0; i < 50; i++) { // safety limit
    try {
      const raw = await readFile(join(current, "progress.ndjson"), "utf8");
      let nextDir: string | null = null;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.event === "loop_restart" && typeof ev.new_logs_root === "string") {
            nextDir = ev.new_logs_root;
          }
        } catch { /* skip */ }
      }
      if (!nextDir || nextDir === current) break;
      dirs.push(nextDir);
      current = nextDir;
    } catch { break; }
  }
  return dirs;
}

async function readAttractorFormat(runId: string, runDir: string): Promise<RunState | null> {
  try {
    const manifestRaw = await readFile(join(runDir, "manifest.json"), "utf8");
    const manifest: Record<string, unknown> = JSON.parse(manifestRaw);

    const goal = typeof manifest.goal === "string" ? manifest.goal : undefined;
    const graphName = typeof manifest.graph_name === "string" ? manifest.graph_name : undefined;
    const startedAt = typeof manifest.started_at === "string" ? manifest.started_at : undefined;
    const logsRoot = typeof manifest.logs_root === "string" ? manifest.logs_root : runDir;
    const repoPath = typeof manifest.repo_path === "string" ? manifest.repo_path : undefined;
    const graphDotPath = typeof manifest.graph_dot === "string" ? manifest.graph_dot : undefined;
    const worktreePath = typeof manifest.worktree === "string" ? manifest.worktree : undefined;
    const repo = repoPath ? repoPath.split("/").pop() : undefined;

    // Read DOT content
    let dot: string | undefined;
    if (graphDotPath) {
      try { dot = await readFile(graphDotPath, "utf8"); } catch { /* ignore */ }
    }

    // Walk restart chain: [runDir, restart-1, restart-2, ...]
    const allDirs = await walkRestartChain(runDir);
    const latestDir = allDirs[allDirs.length - 1];
    const restartCount = allDirs.length - 1;

    // Read checkpoint from latest dir first, fall back to root
    let currentNode: string | undefined;
    let completedNodes: string[] = [];
    let hasCheckpoint = false;
    let checkpointTs: string | undefined;
    for (const dir of [latestDir, runDir]) {
      try {
        const cpRaw = await readFile(join(dir, "checkpoint.json"), "utf8");
        const cp: Record<string, unknown> = JSON.parse(cpRaw);
        currentNode = typeof cp.current_node === "string" ? cp.current_node : undefined;
        completedNodes = Array.isArray(cp.completed_nodes) ? cp.completed_nodes.map(String) : [];
        checkpointTs = typeof cp.timestamp === "string" ? cp.timestamp : undefined;
        hasCheckpoint = true;
        break;
      } catch { /* try next */ }
    }

    // Read final.json from latest dir first, fall back to root
    let finalStatus: "completed" | "failed" | undefined;
    let failureReason: string | undefined;
    let finishedAt: string | undefined;
    for (const dir of [latestDir, runDir]) {
      try {
        const finalRaw = await readFile(join(dir, "final.json"), "utf8");
        const final: Record<string, unknown> = JSON.parse(finalRaw);
        const s = String(final.status ?? "");
        if (s === "success") finalStatus = "completed";
        else if (s === "fail") finalStatus = "failed";
        failureReason = typeof final.failure_reason === "string" ? final.failure_reason : undefined;
        finishedAt = typeof final.timestamp === "string" ? final.timestamp : undefined;
        break;
      } catch { /* try next */ }
    }

    // Get last heartbeat from latest dir's progress.ndjson
    let lastHeartbeat: string | undefined;
    try {
      const progressPath = join(latestDir, "progress.ndjson");
      const { size } = await stat(progressPath);
      const tailSize = Math.min(size, 4096);
      const buf = Buffer.alloc(tailSize);
      const { default: fs } = await import("node:fs");
      const fh = await fs.promises.open(progressPath, "r");
      await fh.read(buf, 0, tailSize, size - tailSize);
      await fh.close();
      const lines = buf.toString().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev: Record<string, unknown> = JSON.parse(lines[i]);
          const ts = typeof ev.ts === "string" ? ev.ts : undefined;
          if (ts) { lastHeartbeat = ts; break; }
        } catch { /* skip */ }
      }
    } catch { /* no progress.ndjson */ }

    // Check PID liveness — try latest dir first, then root
    let containerAlive = false;
    if (!finalStatus && hasCheckpoint) {
      for (const dir of [latestDir, runDir]) {
        try {
          const pidRaw = await readFile(join(dir, "run.pid"), "utf8");
          const pid = parseInt(pidRaw.trim(), 10);
          if (!isNaN(pid)) { containerAlive = await checkPidAlive(pid); break; }
        } catch { /* try next */ }
      }
    }

    // Determine status
    let status: RunStatus;
    if (finalStatus) {
      status = finalStatus;
    } else if (hasCheckpoint) {
      status = containerAlive ? "executing" : "interrupted";
    } else {
      status = "pending";
    }

    // Merge stage histories across all dirs in order, tagging each with restartIndex
    const stageHistory: VisitedStage[] = [];
    let mergedCycleInfo: CycleInfo | undefined;
    for (let i = 0; i < allDirs.length; i++) {
      const { history, cycleInfo: ci } = await parseProgressHistory(join(allDirs[i], "progress.ndjson"));
      stageHistory.push(...history.map((v) => ({ ...v, restartIndex: i })));
      if (ci) mergedCycleInfo = ci;
    }
    const cycleInfo = mergedCycleInfo;

    // Merge stages from all dirs; later dirs override earlier for same node_id
    const stageMap = new Map<string, StageInfo>();
    for (const dir of allDirs) {
      const dirStages = await readAttractorStages(dir, completedNodes);
      for (const s of dirStages) stageMap.set(s.node_id, s);
    }
    const stages = [...stageMap.values()];

    const run: RunRecord = {
      id: runId,
      repo,
      dot_file: graphName,
      status,
      current_node: currentNode,
      started_at: startedAt,
      finished_at: finishedAt,
      last_heartbeat: lastHeartbeat ?? checkpointTs,
      failure_reason: failureReason,
      attractor_run_id: runId,
      attractor_logs_root: logsRoot,
      has_checkpoint: hasCheckpoint,
      params: goal ? { goal } : undefined,
      completed_nodes: completedNodes,
    };

    // Parse retry_target from DOT graph attributes to enable accurate cycle-loop node detection
    let resolvedCycleInfo = cycleInfo;
    if (resolvedCycleInfo && dot) {
      const retryTargetMatch = /\bretry_target\s*=\s*"([^"]+)"/.exec(dot);
      if (retryTargetMatch) resolvedCycleInfo = { ...resolvedCycleInfo, retryTargetNodeId: retryTargetMatch[1] };
    }

    return {
      run,
      containerAlive,
      computedStatus: deriveComputedStatus(run, containerAlive),
      lastChecked: new Date().toISOString(),
      dot,
      stages,
      stageHistory,
      cycleInfo: resolvedCycleInfo,
      restartCount: restartCount > 0 ? restartCount : undefined,
      worktreePath,
      format: "attractor",
    };
  } catch (err) {
    console.error(`[RunWatcher] attractor read error for ${runId}:`, err);
    return null;
  }
}

async function parseProgressHistory(progressPath: string): Promise<{ history: VisitedStage[]; cycleInfo?: CycleInfo }> {
  try {
    const raw = await readFile(progressPath, "utf8");
    const lines = raw.split("\n");
    // key: "nodeId:attempt" → visit currently in flight
    const inFlight = new Map<string, VisitedStage>();
    const history: VisitedStage[] = [];
    let cycleInfo: CycleInfo | undefined;

    // key: "nodeId:attempt" for main stages, "fanOut/branchKey/nodeId:attempt" for branches
    const branchInFlight = new Map<string, VisitedStage>();
    // Track which fan-out node each branch key belongs to (for insertion order)
    const fanOutForBranch = new Map<string, string>();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev: Record<string, unknown> = JSON.parse(line);
        const event = String(ev.event ?? "");
        const ts = typeof ev.ts === "string" ? ev.ts : null;
        if (!ts) continue;

        // ── Branch stage events ──────────────────────────────────────────────
        if (event === "branch_progress") {
          const branch_event = String(ev.branch_event ?? "");
          const branch_key = typeof ev.branch_key === "string" ? ev.branch_key : null;
          const branch_node_id = typeof ev.branch_node_id === "string" ? ev.branch_node_id : null;
          const branch_logs_root = typeof ev.branch_logs_root === "string" ? ev.branch_logs_root : null;
          if (!branch_key || !branch_node_id) continue;

          // Determine parent fan-out node from the last main stage in history
          if (!fanOutForBranch.has(branch_key)) {
            const lastMain = [...history].reverse().find((v) => !v.fan_out_node);
            if (lastMain) fanOutForBranch.set(branch_key, lastMain.node_id);
          }
          const fan_out_node = fanOutForBranch.get(branch_key);
          if (!fan_out_node) continue;

          const branch_attempt = typeof ev.branch_attempt === "number" ? ev.branch_attempt : 1;
          const bKey = `${fan_out_node}/${branch_key}/${branch_node_id}:${branch_attempt}`;

          if (branch_event === "stage_attempt_start") {
            // Derive relative stage path from logs_root
            const stage_path = branch_logs_root
              ? `${branch_logs_root.split("/").slice(-3).join("/")}/${branch_node_id}`
              : undefined;
            const visit: VisitedStage = {
              node_id: branch_node_id,
              attempt: branch_attempt,
              status: "running",
              started_at: ts,
              fan_out_node,
              branch_key,
              stage_path,
            };
            branchInFlight.set(bKey, visit);
            history.push(visit);
          } else if (branch_event === "stage_attempt_end") {
            const visit = branchInFlight.get(bKey);
            if (visit) {
              const s = String(ev.branch_status ?? "");
              visit.status = s === "fail" ? "fail" : "pass";
              visit.finished_at = ts;
              visit.duration_s = Math.round(
                (new Date(ts).getTime() - new Date(visit.started_at).getTime()) / 1000
              );
              if (typeof ev.branch_failure_reason === "string" && ev.branch_failure_reason) {
                visit.failure_reason = ev.branch_failure_reason;
              }
              branchInFlight.delete(bKey);
            }
          }
          continue;
        }

        // ── Cycle detection events ───────────────────────────────────────────
        if (event === "deterministic_failure_cycle_check" || event === "deterministic_failure_cycle_breaker") {
          const failing_node_id = typeof ev.node_id === "string" ? ev.node_id : null;
          const signature = typeof ev.signature === "string" ? ev.signature : "";
          const signature_count = typeof ev.signature_count === "number" ? ev.signature_count : 0;
          const signature_limit = typeof ev.signature_limit === "number" ? ev.signature_limit : 0;
          if (failing_node_id) {
            // Keep the highest-count (latest) event as the authoritative cycle info
            if (!cycleInfo || signature_count >= cycleInfo.signatureCount) {
              cycleInfo = {
                failingNodeId: failing_node_id,
                signature,
                signatureCount: signature_count,
                signatureLimit: signature_limit,
                isBreaker: event === "deterministic_failure_cycle_breaker",
              };
            }
          }
          continue;
        }

        // ── Main stage events ────────────────────────────────────────────────
        const node_id = typeof ev.node_id === "string" ? ev.node_id : null;
        const attempt = typeof ev.attempt === "number" ? ev.attempt : 1;
        if (!node_id) continue;

        const key = `${node_id}:${attempt}`;

        if (event === "stage_attempt_start") {
          const visit: VisitedStage = { node_id, attempt, status: "running", started_at: ts };
          inFlight.set(key, visit);
          history.push(visit);
        } else if (event === "stage_attempt_end") {
          const visit = inFlight.get(key);
          if (visit) {
            const s = String(ev.status ?? "");
            // Only "fail" is a canonical failure — all custom statuses mean the
            // stage completed successfully and chose a particular branch.
            visit.status = s === "fail" ? "fail" : "pass";
            visit.finished_at = ts;
            visit.duration_s = Math.round(
              (new Date(ts).getTime() - new Date(visit.started_at).getTime()) / 1000
            );
            if (typeof ev.failure_reason === "string" && ev.failure_reason) {
              visit.failure_reason = ev.failure_reason;
            }
            inFlight.delete(key);
          }
        }
      } catch { /* skip malformed */ }
    }
    return { history, cycleInfo };
  } catch {
    return { history: [] };
  }
}

async function readAttractorStages(runDir: string, completedNodes: string[]): Promise<StageInfo[]> {
  const stages: StageInfo[] = [];
  const completedSet = new Set(completedNodes);
  try {
    const entries = await readdir(runDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nodeDir = join(runDir, entry.name);
      const statusPath = join(nodeDir, "status.json");
      try {
        const raw = await readFile(statusPath, "utf8");
        const s: Record<string, unknown> = JSON.parse(raw);
        stages.push({
          node_id: entry.name,
          status: String(s.status ?? "unknown"),
          failure_reason: typeof s.failure_reason === "string" ? s.failure_reason : undefined,
          context_updates: s.context_updates && typeof s.context_updates === "object"
            ? (s.context_updates as Record<string, unknown>)
            : undefined,
        });
      } catch {
        // Directory exists but no status.json — infer from completedNodes
        if (completedSet.has(entry.name)) {
          stages.push({ node_id: entry.name, status: "pass" });
        }
      }
    }
  } catch { /* ignore */ }
  return stages;
}

// ─── RunWatcher ───────────────────────────────────────────────────────────────

export class RunWatcher extends EventEmitter {
  private runsDirs: string[];
  private dirForRun = new Map<string, string>(); // runId → resolved run dir
  private watchers = new Map<string, FSWatcher>();
  private cache = new Map<string, RunState>();
  private polling = new Map<string, ReturnType<typeof setInterval>>();

  constructor(runsDirs: string[]) {
    super();
    this.runsDirs = runsDirs;
  }

  getRunsDirs(): string[] { return this.runsDirs; }

  /** Find the directory for a run across all configured runsDirs. */
  async findRunDir(runId: string): Promise<string | null> {
    if (this.dirForRun.has(runId)) return this.dirForRun.get(runId)!;
    for (const dir of this.runsDirs) {
      const runDir = join(dir, runId);
      try { await stat(join(runDir, "run.json")); this.dirForRun.set(runId, runDir); return runDir; } catch { /* try next */ }
      try { await stat(join(runDir, "manifest.json")); this.dirForRun.set(runId, runDir); return runDir; } catch { /* try next */ }
    }
    return null;
  }

  async watch(runId: string): Promise<RunState | null> {
    if (this.cache.has(runId)) {
      return this.cache.get(runId)!;
    }

    const runDir = await this.findRunDir(runId);
    if (!runDir) return null;
    const state = await this.readRunState(runId, runDir);
    if (state) this.cache.set(runId, state);

    // Debounced update: batch rapid file-change bursts into one re-read
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleUpdate = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        debounce = null;
        const newState = await this.readRunState(runId, runDir);
        if (newState) {
          this.cache.set(runId, newState);
          this.emit("update", runId, newState);
        }
      }, 200);
    };

    // Watch the whole run directory tree.
    // Exclude events.ndjson (LLM streaming — appended every few ms, irrelevant for run
    // state and resets awaitWriteFinish timers preventing all other change events from
    // firing) and binary/archive files.
    const fsWatcher = chokidar.watch(runDir, {
      persistent: false,
      ignoreInitial: true,
      ignored: (filePath: string) => {
        const base = filePath.split("/").pop() ?? "";
        return base === "events.ndjson" || base.endsWith(".tgz") || base.endsWith(".gz");
      },
      // No awaitWriteFinish — our 200ms debounce serves the same purpose without
      // blocking events while append-only files are being written.
    });

    fsWatcher.on("change", scheduleUpdate);
    fsWatcher.on("add", scheduleUpdate);

    this.watchers.set(runId, fsWatcher);

    if (state?.run?.status === "executing") {
      this.startPolling(runId, runDir);
    }

    return state;
  }

  private startPolling(runId: string, runDir: string) {
    if (this.polling.has(runId)) return;
    const interval = setInterval(async () => {
      const cached = this.cache.get(runId);
      if (cached && ["completed", "failed", "interrupted", "stopped"].includes(cached.run.status ?? "")) {
        this.stopPolling(runId);
        return;
      }
      const newState = await this.readRunState(runId, runDir);
      if (newState) {
        const prev = this.cache.get(runId);
        if (!prev || newState.computedStatus !== prev.computedStatus || newState.containerAlive !== prev.containerAlive) {
          this.cache.set(runId, newState);
          this.emit("update", runId, newState);
        }
      }
    }, 10_000);
    this.polling.set(runId, interval);
  }

  private stopPolling(runId: string) {
    const interval = this.polling.get(runId);
    if (interval) { clearInterval(interval); this.polling.delete(runId); }
  }

  private async readRunState(runId: string, runDir: string): Promise<RunState | null> {
    // Try kilroy-dash format first
    try {
      await stat(join(runDir, "run.json"));
      return readKilroyDashFormat(runDir);
    } catch { /* fall through */ }

    // Try raw attractor format
    try {
      await stat(join(runDir, "manifest.json"));
      return readAttractorFormat(runId, runDir);
    } catch { /* fall through */ }

    return null;
  }

  getState(runId: string): RunState | undefined {
    return this.cache.get(runId);
  }

  invalidate(runId: string) {
    this.cache.delete(runId);
  }

  unwatch(runId: string) {
    this.watchers.get(runId)?.close();
    this.watchers.delete(runId);
    this.stopPolling(runId);
    this.cache.delete(runId);
  }

  close() {
    for (const w of this.watchers.values()) w.close();
    for (const i of this.polling.values()) clearInterval(i);
    this.watchers.clear();
    this.polling.clear();
    this.cache.clear();
  }
}
