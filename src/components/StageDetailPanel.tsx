import { useState, useEffect } from "react";
import type { RunRecord, VisitedStage, TurnsData } from "../lib/types";
import { FileVisualizer } from "./FileVisualizers";
import { TurnViewer } from "./TurnViewer";

interface Props {
  run: RunRecord;
  stageHistory: VisitedStage[];
  selectedHistoryIndex: number;
  onSelectVisit: (index: number) => void;
  onClose: () => void;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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

interface ParallelBranch {
  branch_key?: string;
  start_node_id?: string;
  last_node_id?: string;
  logs_root?: string;
  completed_nodes?: string[];
  outcome?: {
    status?: string;
    context_updates?: Record<string, unknown>;
    notes?: string;
  };
}

function ParallelResultsRenderer({ branches }: { branches: ParallelBranch[] }) {
  return (
    <div className="space-y-2">
      {branches.map((b, i) => {
        const status = b.outcome?.status ?? "unknown";
        const isOk = status === "success";
        const lastResponse = typeof b.outcome?.context_updates?.last_response === "string"
          ? b.outcome.context_updates.last_response
          : null;
        const iconCls = isOk ? "text-green-400" : "text-red-400";
        const icon = isOk ? "✓" : "✗";
        const borderCls = isOk ? "border-green-900/40" : "border-red-900/40";
        const completedCount = b.completed_nodes?.length ?? 0;

        return (
          <div key={b.branch_key ?? i} className={`border rounded p-2 bg-gray-900/50 ${borderCls}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`text-xs ${iconCls}`}>{icon}</span>
              <span className="text-xs font-mono font-medium text-gray-200">{b.branch_key ?? `branch-${i}`}</span>
              {b.start_node_id && b.last_node_id && b.start_node_id !== b.last_node_id && (
                <span className="text-[10px] text-gray-500">{b.start_node_id} → {b.last_node_id}</span>
              )}
              {completedCount > 0 && (
                <span className="ml-auto text-[10px] text-gray-600">{completedCount} node{completedCount !== 1 ? "s" : ""}</span>
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
  );
}

function isParallelResults(v: unknown): v is ParallelBranch[] {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === "object" &&
    v[0] !== null && ("branch_key" in v[0] || "outcome" in v[0]);
}

function ContextEntry({ k, v }: { k: string; v: unknown }) {
  if (isParallelResults(v)) {
    return (
      <div>
        <div className="text-xs text-gray-500 mb-1.5">
          {k} <span className="text-gray-600">({v.length} branches)</span>
        </div>
        <ParallelResultsRenderer branches={v} />
      </div>
    );
  }
  if (typeof v === "string" && v.includes("\n")) {
    return (
      <div>
        <div className="text-xs text-gray-500 mb-0.5">{k}</div>
        <FileVisualizer fileName={`${k}.log`} mime="text/plain" content={v} />
      </div>
    );
  }
  const display = typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
  return (
    <div>
      <span className="text-xs text-gray-500">{k}: </span>
      <span className="text-xs text-gray-300 font-mono break-all">{display}</span>
    </div>
  );
}

type Tab = "turns" | "response" | "prompt" | "context";

interface StageFiles {
  contextUpdates: Record<string, unknown>;
  hasResponse: boolean;
  hasPrompt: boolean;
  hasTurns: boolean;
}

async function fetchStageFiles(runId: string, stagePath: string): Promise<StageFiles> {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stages/${stagePath}`);
    if (!res.ok) return { contextUpdates: {}, hasResponse: false, hasPrompt: false, hasTurns: false };
    const data = await res.json();
    const files: string[] = data.files ?? [];
    return {
      contextUpdates: (data.context_updates as Record<string, unknown>) ?? {},
      hasResponse: files.includes("response.md"),
      hasPrompt: files.includes("prompt.md"),
      hasTurns: files.includes("events.ndjson"),
    };
  } catch {
    return { contextUpdates: {}, hasResponse: false, hasPrompt: false, hasTurns: false };
  }
}

async function fetchFileContent(runId: string, stagePath: string, fileName: string): Promise<string> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stages/${stagePath}/${encodeURIComponent(fileName)}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

async function fetchTurns(runId: string, stagePath: string): Promise<TurnsData> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stages/${stagePath}/turns`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export function StageDetailPanel({
  run, stageHistory, selectedHistoryIndex, onSelectVisit, onClose,
}: Props) {
  const visit = stageHistory[selectedHistoryIndex];
  const nodeId = visit?.node_id ?? "";
  // For branch stages, use the full relative path (e.g. "parallel/dod_fanout/01-dod_a/dod_a")
  const stagePath = visit?.stage_path ?? nodeId;

  // All visits for this node (to show picker)
  const visitsForNode = stageHistory
    .map((v, i) => ({ visit: v, index: i }))
    .filter(({ visit: v }) => v.node_id === nodeId);

  const isLatestVisit = visitsForNode.length > 0 &&
    visitsForNode[visitsForNode.length - 1].index === selectedHistoryIndex;

  // Which node's files are loaded (always latest execution)
  const latestVisitForNode = visitsForNode[visitsForNode.length - 1]?.visit;

  const [tab, setTab] = useState<Tab>("turns");
  const [stageFiles, setStageFiles] = useState<StageFiles>({ contextUpdates: {}, hasResponse: false, hasPrompt: false, hasTurns: false });
  const [responseContent, setResponseContent] = useState<string | null>(null);
  const [promptContent, setPromptContent] = useState<string | null>(null);
  const [turnsData, setTurnsData] = useState<TurnsData | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  // Re-fetch stage metadata when the stage path changes
  useEffect(() => {
    if (!stagePath) return;
    setStageFiles({ contextUpdates: {}, hasResponse: false, hasPrompt: false, hasTurns: false });
    setResponseContent(null);
    setPromptContent(null);
    setTurnsData(null);
    // Default tab: response if stage is done, turns if it has events, else context
    setTab("response");
    fetchStageFiles(run.id, stagePath).then((sf) => {
      setStageFiles(sf);
      // If stage completed and has a response, show response first;
      // otherwise fall back to turns (in-progress or tool node)
      if (sf.hasResponse) {
        setTab("response");
      } else if (sf.hasTurns) {
        setTab("turns");
      } else {
        setTab("context");
      }
    });
  }, [run.id, stagePath]);

  // Fetch file/turns content when tab changes
  useEffect(() => {
    if (tab === "turns" && stageFiles.hasTurns && turnsData === null) {
      setLoadingFile(true);
      fetchTurns(run.id, stagePath)
        .then((d) => setTurnsData(d))
        .catch(() => setTurnsData({ turns: [] }))
        .finally(() => setLoadingFile(false));
    }
    if (tab === "response" && stageFiles.hasResponse && responseContent === null) {
      setLoadingFile(true);
      fetchFileContent(run.id, stagePath, "response.md")
        .then((c) => setResponseContent(c))
        .catch(() => setResponseContent("(failed to load)"))
        .finally(() => setLoadingFile(false));
    }
    if (tab === "prompt" && stageFiles.hasPrompt && promptContent === null) {
      setLoadingFile(true);
      fetchFileContent(run.id, stagePath, "prompt.md")
        .then((c) => setPromptContent(c))
        .catch(() => setPromptContent("(failed to load)"))
        .finally(() => setLoadingFile(false));
    }
  }, [tab, stageFiles, run.id, stagePath, turnsData, responseContent, promptContent]);

  if (!visit) return null;

  const contextEntries = Object.entries(stageFiles.contextUpdates);
  const tabs: { id: Tab; label: string; available: boolean }[] = [
    { id: "response", label: "Response", available: stageFiles.hasResponse },
    { id: "turns", label: "Turns", available: stageFiles.hasTurns },
    { id: "prompt", label: "Prompt", available: stageFiles.hasPrompt },
    { id: "context", label: `Context${contextEntries.length > 0 ? ` (${contextEntries.length})` : ""}`, available: true },
  ];

  return (
    <div className="w-96 h-full border-l border-gray-800 flex flex-col shrink-0 overflow-hidden bg-gray-900/30">
      {/* Header */}
      <div className="border-b border-gray-800 px-3 py-2 shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-gray-200 truncate font-medium">{nodeId}</span>
          <StatusBadge status={visit.status} />
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-200 text-xs px-2 py-1 rounded hover:bg-gray-800 shrink-0"
        >
          ✕
        </button>
      </div>

      {/* Visit picker (if multiple visits to this node) */}
      {visitsForNode.length > 1 && (
        <div className="border-b border-gray-800 px-2 py-1.5 shrink-0">
          <div className="text-[10px] text-gray-600 mb-1 uppercase tracking-wide">
            {visitsForNode.length} visits to this node
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

      {/* Selected visit timing */}
      <div className="border-b border-gray-800 px-3 py-2 shrink-0 space-y-1">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
          <span>{fmtTime(visit.started_at)}{visit.finished_at ? ` → ${fmtTime(visit.finished_at)}` : " → running"}</span>
          {visit.duration_s != null && (
            <span className="text-gray-400 font-medium">{fmtDuration(visit.duration_s)}</span>
          )}
          {latestVisitForNode && !isLatestVisit && (
            <span className="text-amber-400/70">visit {visitsForNode.findIndex(({ index }) => index === selectedHistoryIndex) + 1} of {visitsForNode.length}</span>
          )}
        </div>
        {visit.failure_reason && (
          <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
            {visit.failure_reason}
          </div>
        )}
        {!isLatestVisit && stageFiles.hasResponse && (
          <div className="text-[10px] text-amber-400/60 bg-amber-900/10 rounded px-2 py-1">
            Response, prompt &amp; context are from the most recent execution
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 shrink-0 overflow-x-auto">
        {tabs.map(({ id, label, available }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 text-xs whitespace-nowrap ${
              tab === id
                ? "text-gray-100 border-b-2 border-blue-500"
                : available
                  ? "text-gray-500 hover:text-gray-300"
                  : "text-gray-700 cursor-default"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {tab === "turns" && (
          !stageFiles.hasTurns ? (
            <div className="p-3 text-xs text-gray-500">No events recorded (tool node)</div>
          ) : loadingFile && turnsData === null ? (
            <div className="p-3 text-xs text-gray-500">Loading…</div>
          ) : turnsData !== null ? (
            <TurnViewer data={turnsData} />
          ) : null
        )}

        {tab === "response" && (
          <div className="p-3">
            {!stageFiles.hasResponse ? (
              <div className="text-xs text-gray-500">No response file available</div>
            ) : loadingFile && responseContent === null ? (
              <div className="text-xs text-gray-500">Loading…</div>
            ) : responseContent !== null ? (
              <FileVisualizer fileName="response.md" mime="text/markdown" content={responseContent} />
            ) : null}
          </div>
        )}

        {tab === "prompt" && (
          <div className="p-3">
            {!stageFiles.hasPrompt ? (
              <div className="text-xs text-gray-500">No prompt file available</div>
            ) : loadingFile && promptContent === null ? (
              <div className="text-xs text-gray-500">Loading…</div>
            ) : promptContent !== null ? (
              <FileVisualizer fileName="prompt.md" mime="text/markdown" content={promptContent} />
            ) : null}
          </div>
        )}

        {tab === "context" && (
          <div className="p-3 space-y-2">
            {contextEntries.length === 0 ? (
              <div className="text-xs text-gray-500">No context updates</div>
            ) : (
              contextEntries.map(([k, v]) => <ContextEntry key={k} k={k} v={v} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}
