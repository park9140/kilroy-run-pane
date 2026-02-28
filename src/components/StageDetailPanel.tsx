import { useState, useEffect, useMemo } from "react";
import type { RunRecord, VisitedStage, TurnsData } from "../lib/types";
import { FileVisualizer } from "./FileVisualizers";
import { TurnViewer } from "./TurnViewer";

interface Props {
  run: RunRecord;
  stageHistory: VisitedStage[];
  selectedHistoryIndex: number;
  onSelectVisit: (index: number) => void;
  onClose: () => void;
  /** Raw DOT string for parsing node attributes (shape, label, etc.) */
  dot?: string;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls =
    s === "pass" ? "bg-green-500/20 text-green-400" :
    s === "fail" ? "bg-red-500/20 text-red-400" :
    s === "running" ? "bg-amber-500/20 text-amber-400 animate-pulse" :
    "bg-gray-500/20 text-gray-400";
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}`}>{status}</span>;
}

// ── DOT attribute parsing ────────────────────────────────────────────────────

function parseNodeDotAttrs(dot: string, nodeId: string): Record<string, string> {
  if (!dot || !nodeId) return {};
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the node definition block (non-greedy, handle nested braces via char class)
  const nodeRe = new RegExp(`\\b${escaped}\\s*\\[([^\\]]{0,8000})\\]`);
  const m = nodeRe.exec(dot);
  if (!m) return {};
  const attrs: Record<string, string> = {};
  // key="value" or key=bare_word
  const attrRe = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,\]]+))/g;
  let am;
  while ((am = attrRe.exec(m[1])) !== null) {
    attrs[am[1]] = (am[2] ?? am[3] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return attrs;
}

type NodeKind = "llm" | "tool" | "fanout" | "routing";

function getNodeKind(
  dotAttrs: Record<string, string>,
  files: string[],
  contextUpdates: Record<string, unknown>,
): NodeKind {
  const shape = dotAttrs.shape;
  // Shape-first classification
  if (shape === "parallelogram") return "tool";
  if (shape === "component") return "fanout";
  if (shape === "diamond" || shape === "Mdiamond" || shape === "Msquare") return "routing";
  if (shape === "box") return "llm";
  // Fallback: file-based detection
  if (files.includes("tool_invocation.json")) return "tool";
  if (Array.isArray(contextUpdates["parallel.results"])) return "fanout";
  if (files.includes("events.ndjson")) return "llm";
  return "routing";
}

// ── Stage file metadata ──────────────────────────────────────────────────────

interface StageFiles {
  contextUpdates: Record<string, unknown>;
  notes?: string;
  files: string[];
  hasResponse: boolean;
  hasPrompt: boolean;
  hasTurns: boolean;
}

const EMPTY_STAGE_FILES: StageFiles = {
  contextUpdates: {}, files: [],
  hasResponse: false, hasPrompt: false, hasTurns: false,
};

async function fetchStageFiles(runId: string, stagePath: string): Promise<StageFiles> {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stages/${stagePath}`);
    if (!res.ok) return EMPTY_STAGE_FILES;
    const data = await res.json() as Record<string, unknown>;
    const files: string[] = Array.isArray(data.files) ? (data.files as string[]) : [];
    return {
      contextUpdates: (data.context_updates as Record<string, unknown>) ?? {},
      notes: typeof data.notes === "string" ? data.notes : undefined,
      files,
      hasResponse: files.includes("response.md"),
      hasPrompt: files.includes("prompt.md"),
      hasTurns: files.includes("events.ndjson"),
    };
  } catch {
    return EMPTY_STAGE_FILES;
  }
}

async function fetchFileContent(runId: string, stagePath: string, fileName: string): Promise<string> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/stages/${stagePath}/${encodeURIComponent(fileName)}`
  );
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

async function fetchTurns(runId: string, stagePath: string): Promise<TurnsData> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stages/${stagePath}/turns`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ── Parallel branch types ────────────────────────────────────────────────────

interface ParallelBranch {
  branch_key?: string;
  start_node_id?: string;
  last_node_id?: string;
  completed_nodes?: string[];
  outcome?: { status?: string; context_updates?: Record<string, unknown>; notes?: string };
}

function isParallelResults(v: unknown): v is ParallelBranch[] {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null &&
    ("branch_key" in (v[0] as object) || "outcome" in (v[0] as object));
}

// ── Section label ──────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] text-gray-600 uppercase tracking-widest mb-1.5 font-medium">
      {children}
    </div>
  );
}

// ── LLM node view ────────────────────────────────────────────────────────────

type LLMTab = "response" | "turns" | "prompt";

function LLMNodeContent({
  run, stagePath, stageFiles, isLatestVisit,
}: {
  run: RunRecord;
  stagePath: string;
  stageFiles: StageFiles;
  isLatestVisit: boolean;
}) {
  const [tab, setTab] = useState<LLMTab>("response");
  const [responseContent, setResponseContent] = useState<string | null>(null);
  const [promptContent, setPromptContent] = useState<string | null>(null);
  const [turnsData, setTurnsData] = useState<TurnsData | null>(null);
  const [loading, setLoading] = useState(false);

  // Default to first available tab when stageFiles loads
  useEffect(() => {
    if (stageFiles.hasResponse) setTab("response");
    else if (stageFiles.hasTurns) setTab("turns");
    else setTab("prompt");
  }, [stageFiles.hasResponse, stageFiles.hasTurns]);

  useEffect(() => {
    if (tab === "response" && stageFiles.hasResponse && responseContent === null) {
      setLoading(true);
      fetchFileContent(run.id, stagePath, "response.md")
        .then(setResponseContent).catch(() => setResponseContent("(failed to load)"))
        .finally(() => setLoading(false));
    }
    if (tab === "turns" && stageFiles.hasTurns && turnsData === null) {
      setLoading(true);
      fetchTurns(run.id, stagePath)
        .then(setTurnsData).catch(() => setTurnsData({ turns: [] }))
        .finally(() => setLoading(false));
    }
    if (tab === "prompt" && stageFiles.hasPrompt && promptContent === null) {
      setLoading(true);
      fetchFileContent(run.id, stagePath, "prompt.md")
        .then(setPromptContent).catch(() => setPromptContent("(failed to load)"))
        .finally(() => setLoading(false));
    }
  }, [tab, stageFiles, run.id, stagePath, responseContent, turnsData, promptContent]);

  const tabs: { id: LLMTab; label: string; available: boolean }[] = [
    { id: "response", label: "Response", available: stageFiles.hasResponse },
    { id: "turns",    label: "Turns",    available: stageFiles.hasTurns },
    { id: "prompt",   label: "Prompt",   available: stageFiles.hasPrompt },
  ];

  // Only show tabs that are available or the active one
  const visibleTabs = tabs.filter((t) => t.available);
  if (visibleTabs.length === 0) {
    return <div className="p-3 text-xs text-gray-500">No output recorded for this node.</div>;
  }

  return (
    <>
      {!isLatestVisit && stageFiles.hasResponse && (
        <div className="px-3 py-1.5 text-[10px] text-amber-400/60 bg-amber-900/10 border-b border-gray-800 shrink-0">
          Showing files from most recent execution
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-gray-800 shrink-0 overflow-x-auto">
        {visibleTabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 text-xs whitespace-nowrap ${
              tab === id
                ? "text-gray-100 border-b-2 border-blue-500"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {tab === "response" && (
          <div className="p-3">
            {loading && responseContent === null ? (
              <div className="text-xs text-gray-500">Loading…</div>
            ) : responseContent !== null ? (
              <FileVisualizer fileName="response.md" mime="text/markdown" content={responseContent} />
            ) : (
              <div className="text-xs text-gray-500">No response file available.</div>
            )}
          </div>
        )}
        {tab === "turns" && (
          loading && turnsData === null ? (
            <div className="p-3 text-xs text-gray-500">Loading…</div>
          ) : turnsData !== null ? (
            <TurnViewer data={turnsData} />
          ) : null
        )}
        {tab === "prompt" && (
          <div className="p-3">
            {loading && promptContent === null ? (
              <div className="text-xs text-gray-500">Loading…</div>
            ) : promptContent !== null ? (
              <FileVisualizer fileName="prompt.md" mime="text/markdown" content={promptContent} />
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

// ── Tool node view ────────────────────────────────────────────────────────────

function ToolNodeContent({
  run, stagePath, stageFiles, dotAttrs,
}: {
  run: RunRecord;
  stagePath: string;
  stageFiles: StageFiles;
  dotAttrs: Record<string, string>;
}) {
  const [toolInv, setToolInv] = useState<Record<string, unknown> | null>(null);
  const [stdout, setStdout] = useState<string | null>(null);
  const [stderr, setStderr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const tasks: Promise<void>[] = [];
    if (stageFiles.files.includes("tool_invocation.json")) {
      tasks.push(
        fetchFileContent(run.id, stagePath, "tool_invocation.json")
          .then((t) => { try { setToolInv(JSON.parse(t)); } catch { /* ignore */ } })
          .catch(() => { /* ignore */ })
      );
    }
    if (stageFiles.files.includes("stdout.log")) {
      tasks.push(
        fetchFileContent(run.id, stagePath, "stdout.log")
          .then(setStdout).catch(() => { /* ignore */ })
      );
    }
    if (stageFiles.files.includes("stderr.log")) {
      tasks.push(
        fetchFileContent(run.id, stagePath, "stderr.log")
          .then((t) => setStderr(t.trim() ? t : null)).catch(() => { /* ignore */ })
      );
    }
    Promise.all(tasks).finally(() => setLoading(false));
  }, [run.id, stagePath, stageFiles.files]);

  const command = typeof toolInv?.command === "string" ? toolInv.command
    : typeof toolInv?.argv === "string" ? toolInv.argv
    : Array.isArray(toolInv?.argv) ? (toolInv!.argv as string[]).join(" ")
    : dotAttrs.tool_command ?? null;

  const label = dotAttrs.label;

  if (loading && !command && !stdout) {
    return <div className="flex-1 p-3 text-xs text-gray-500">Loading…</div>;
  }

  return (
    <div className="flex-1 overflow-auto p-3 space-y-4">
      {/* What it does: label + command */}
      {(label || command) && (
        <div>
          {label && <div className="text-sm text-gray-300 font-medium mb-1.5">{label}</div>}
          {command && (
            <>
              <SectionLabel>Command</SectionLabel>
              <pre className="text-[11px] text-gray-300 font-mono bg-gray-900/60 rounded p-2 whitespace-pre-wrap break-all">
                {command}
              </pre>
            </>
          )}
        </div>
      )}

      {/* What it produced: stdout */}
      {stdout ? (
        <div>
          <SectionLabel>Output</SectionLabel>
          <FileVisualizer fileName="stdout.log" mime="text/plain" content={stdout} />
        </div>
      ) : !loading ? (
        <div className="text-xs text-gray-600 italic">No output captured.</div>
      ) : null}

      {/* Errors: stderr (only if non-empty) */}
      {stderr && (
        <div>
          <SectionLabel>
            <span className="text-red-500/70">Stderr</span>
          </SectionLabel>
          <FileVisualizer fileName="stderr.log" mime="text/plain" content={stderr} />
        </div>
      )}
    </div>
  );
}

// ── Fan-out node view ─────────────────────────────────────────────────────────

function FanOutNodeContent({
  stageFiles, dotAttrs,
}: {
  stageFiles: StageFiles;
  dotAttrs: Record<string, string>;
}) {
  const { contextUpdates } = stageFiles;
  const rawResults = contextUpdates["parallel.results"];
  const branches: ParallelBranch[] = isParallelResults(rawResults) ? rawResults : [];
  const joinNode = typeof contextUpdates["parallel.join_node"] === "string"
    ? contextUpdates["parallel.join_node"] : null;
  const label = dotAttrs.label;

  const succeeded = branches.filter((b) => b.outcome?.status === "success").length;
  const failed = branches.length - succeeded;

  if (branches.length === 0) {
    return (
      <div className="flex-1 p-3 text-xs text-gray-500">
        No branch results recorded yet.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3">
      {/* What it does */}
      {label && <div className="text-sm text-gray-300 font-medium">{label}</div>}

      {/* What it did: branch summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-gray-400">{branches.length} parallel {branches.length === 1 ? "branch" : "branches"}</span>
        {succeeded > 0 && <span className="text-green-400">✓ {succeeded} passed</span>}
        {failed > 0 && <span className="text-red-400">✗ {failed} failed</span>}
        {joinNode && <span className="text-gray-600">→ {joinNode}</span>}
      </div>

      {/* How it did it: branch details */}
      <div className="space-y-2">
        {branches.map((b, i) => {
          const status = b.outcome?.status ?? "unknown";
          const isOk = status === "success";
          const lastResponse = typeof b.outcome?.context_updates?.last_response === "string"
            ? b.outcome.context_updates.last_response : null;
          return (
            <div
              key={b.branch_key ?? i}
              className={`border rounded p-2 bg-gray-900/50 ${isOk ? "border-green-900/40" : "border-red-900/40"}`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`text-xs ${isOk ? "text-green-400" : "text-red-400"}`}>
                  {isOk ? "✓" : "✗"}
                </span>
                <span className="text-xs font-mono font-medium text-gray-200">
                  {b.branch_key ?? `branch-${i}`}
                </span>
                {b.start_node_id && b.last_node_id && b.start_node_id !== b.last_node_id && (
                  <span className="text-[10px] text-gray-500">
                    {b.start_node_id} → {b.last_node_id}
                  </span>
                )}
                {(b.completed_nodes?.length ?? 0) > 0 && (
                  <span className="ml-auto text-[10px] text-gray-600">
                    {b.completed_nodes!.length} node{b.completed_nodes!.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              {lastResponse && (
                <div className="text-[11px] text-gray-400 leading-relaxed line-clamp-3 whitespace-pre-wrap">
                  {lastResponse}
                </div>
              )}
              {b.outcome?.notes && (
                <div className="text-[10px] text-gray-600 mt-0.5 italic">{b.outcome.notes}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Routing/decision node view ────────────────────────────────────────────────

function RoutingNodeContent({
  visit, stageFiles, dotAttrs,
}: {
  visit: VisitedStage;
  stageFiles: StageFiles;
  dotAttrs: Record<string, string>;
}) {
  const label = dotAttrs.label;
  const shape = dotAttrs.shape;
  const { notes } = stageFiles;
  const passed = visit.status === "pass";

  // Describe what kind of routing node this is
  const kindLabel =
    shape === "Mdiamond" ? "Pipeline start" :
    shape === "Msquare"  ? "Pipeline exit" :
    label                ? null : // will show label below
    "Routing gate";

  return (
    <div className="flex-1 p-4 space-y-4">
      {/* What this node does */}
      <div>
        {kindLabel && (
          <div className="text-[10px] text-gray-600 uppercase tracking-widest mb-1">{kindLabel}</div>
        )}
        {label && (
          <div className="text-sm text-gray-200 font-medium leading-snug">{label}</div>
        )}
        {!label && !kindLabel && (
          <div className="text-sm text-gray-500">Conditional routing node</div>
        )}
      </div>

      {/* What it decided */}
      <div>
        <SectionLabel>Result</SectionLabel>
        <div className={`flex items-center gap-2 text-sm font-medium ${passed ? "text-green-400" : "text-red-400"}`}>
          <span>{passed ? "✓" : "✗"}</span>
          <span>{passed ? "Passed — pipeline continues" : "Failed"}</span>
        </div>
        {visit.failure_reason && (
          <div className="mt-1 text-xs text-red-400/80">{visit.failure_reason}</div>
        )}
      </div>

      {/* Notes from status.json */}
      {notes && notes !== "conditional pass-through" && (
        <div className="text-[11px] text-gray-600 italic">{notes}</div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function StageDetailPanel({
  run, stageHistory, selectedHistoryIndex, onSelectVisit, onClose, dot,
}: Props) {
  const visit = stageHistory[selectedHistoryIndex];
  const nodeId = visit?.node_id ?? "";
  const stagePath = visit?.stage_path ?? nodeId;

  // All visits to this node (for picker)
  const visitsForNode = useMemo(
    () => stageHistory.map((v, i) => ({ visit: v, index: i })).filter(({ visit: v }) => v.node_id === nodeId),
    [stageHistory, nodeId],
  );

  const isLatestVisit =
    visitsForNode.length > 0 &&
    visitsForNode[visitsForNode.length - 1].index === selectedHistoryIndex;

  // DOT attribute parsing for this node
  const dotAttrs = useMemo(() => parseNodeDotAttrs(dot ?? "", nodeId), [dot, nodeId]);

  // Stage file metadata
  const [stageFiles, setStageFiles] = useState<StageFiles>(EMPTY_STAGE_FILES);
  useEffect(() => {
    if (!stagePath) return;
    setStageFiles(EMPTY_STAGE_FILES);
    fetchStageFiles(run.id, stagePath).then(setStageFiles);
  }, [run.id, stagePath]);

  // Classify the node
  const nodeKind = useMemo(
    () => getNodeKind(dotAttrs, stageFiles.files, stageFiles.contextUpdates),
    [dotAttrs, stageFiles.files, stageFiles.contextUpdates],
  );

  if (!visit) return null;

  // Node kind label shown in header
  const kindChip: Record<NodeKind, string> = {
    llm: "LLM",
    tool: "tool",
    fanout: "fan-out",
    routing: "routing",
  };

  return (
    <div className="w-96 h-full border-l border-gray-800 flex flex-col shrink-0 overflow-hidden bg-gray-900/30">

      {/* ── Header ── */}
      <div className="border-b border-gray-800 px-3 py-2 shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-gray-200 truncate font-medium">{nodeId}</span>
          <StatusBadge status={visit.status} />
          <span className="text-[10px] text-gray-600 shrink-0">{kindChip[nodeKind]}</span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-200 text-xs px-2 py-1 rounded hover:bg-gray-800 shrink-0"
        >
          ✕
        </button>
      </div>

      {/* ── Visit picker ── */}
      {visitsForNode.length > 1 && (
        <div className="border-b border-gray-800 px-2 py-1.5 shrink-0">
          <div className="text-[10px] text-gray-600 mb-1 uppercase tracking-wide">
            {visitsForNode.length} visits
          </div>
          <div className="flex flex-wrap gap-1">
            {visitsForNode.map(({ visit: v, index }, visitNum) => {
              const isSelected = index === selectedHistoryIndex;
              const icon = v.status === "pass" ? "✓" : v.status === "fail" ? "✗" : "●";
              const iconCls = v.status === "pass" ? "text-green-400" : v.status === "fail" ? "text-red-400" : "text-amber-400";
              const dur = v.duration_s != null ? fmtDuration(v.duration_s) : "…";
              return (
                <button
                  key={index}
                  onClick={() => onSelectVisit(index)}
                  title={`${fmtTime(v.started_at)}${v.finished_at ? ` → ${fmtTime(v.finished_at)}` : ""}`}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border transition-colors ${
                    isSelected
                      ? "border-blue-500 bg-blue-500/10 text-gray-200"
                      : "border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-500"
                  }`}
                >
                  <span className={iconCls}>{icon}</span>
                  <span>#{visitNum + 1}</span>
                  <span className="text-gray-500">{dur}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Timing + failure reason ── */}
      <div className="border-b border-gray-800 px-3 py-2 shrink-0 space-y-1">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
          <span>
            {fmtTime(visit.started_at)}
            {visit.finished_at ? ` → ${fmtTime(visit.finished_at)}` : " → running"}
          </span>
          {visit.duration_s != null && (
            <span className="text-gray-400 font-medium">{fmtDuration(visit.duration_s)}</span>
          )}
          {!isLatestVisit && (
            <span className="text-amber-400/70">
              visit {visitsForNode.findIndex(({ index }) => index === selectedHistoryIndex) + 1} of {visitsForNode.length}
            </span>
          )}
        </div>
        {visit.failure_reason && (
          <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
            {visit.failure_reason}
          </div>
        )}
      </div>

      {/* ── Node-type-specific body ── */}
      {nodeKind === "llm" && (
        <LLMNodeContent
          run={run}
          stagePath={stagePath}
          stageFiles={stageFiles}
          isLatestVisit={isLatestVisit}
        />
      )}

      {nodeKind === "tool" && (
        <ToolNodeContent
          run={run}
          stagePath={stagePath}
          stageFiles={stageFiles}
          dotAttrs={dotAttrs}
        />
      )}

      {nodeKind === "fanout" && (
        <FanOutNodeContent
          stageFiles={stageFiles}
          dotAttrs={dotAttrs}
        />
      )}

      {nodeKind === "routing" && (
        <RoutingNodeContent
          visit={visit}
          stageFiles={stageFiles}
          dotAttrs={dotAttrs}
        />
      )}
    </div>
  );
}
