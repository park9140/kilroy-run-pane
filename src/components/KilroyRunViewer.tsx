import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useRunMonitor } from "../hooks/useRunMonitor";
import { DotPreview } from "./DotPreview";
import { StageSidebar } from "./StageSidebar";
import { StageDetailPanel } from "./StageDetailPanel";
import { WorkspacePanel } from "./WorkspacePanel";
import type { ComputedStatus } from "../lib/types";
import { parseAllNodeLabels } from "../lib/dotUtils";

function StatusBadge({ status }: { status: ComputedStatus | undefined }) {
  if (!status) return null;
  const config: Record<ComputedStatus, { label: string; classes: string }> = {
    executing: { label: "Executing", classes: "bg-amber-500/20 text-amber-400 animate-pulse" },
    stalled: { label: "Stalled", classes: "bg-orange-500/20 text-orange-400" },
    completed: { label: "Completed", classes: "bg-green-500/20 text-green-400" },
    failed: { label: "Failed", classes: "bg-red-500/20 text-red-400" },
    interrupted: { label: "Interrupted", classes: "bg-orange-500/20 text-orange-400" },
    unknown: { label: "Unknown", classes: "bg-gray-500/20 text-gray-400" },
  };
  const c = config[status] ?? config.unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${c.classes}`}>
      {c.label}
    </span>
  );
}

function HeartbeatAge({ lastHeartbeat }: { lastHeartbeat?: string }) {
  if (!lastHeartbeat) return null;
  const ms = Date.now() - new Date(lastHeartbeat).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 0) return null;
  const label = secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
  return <span className="text-[10px] text-gray-500">heartbeat {label}</span>;
}

export function KilroyRunViewer() {
  const { runId } = useParams<{ runId: string }>();
  const { runState, stages, stageHistory, dot, loading, error, connected } = useRunMonitor(runId);

  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState<number | null>(null);
  const [hoveredHistoryIndex, setHoveredHistoryIndex] = useState<number | null>(null);
  // Node clicked but not yet in execution history (pending / not yet reached)
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);
  // True once the user has explicitly closed the detail panel — prevents re-auto-opening on SSE updates.
  const userClosedRef = useRef(false);
  // Workspace file browser toggle
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // Cycle steps menu toggle
  const [cycleMenuOpen, setCycleMenuOpen] = useState(false);

  const run = runState?.run;

  // Map node IDs → human-readable labels from the DOT graph
  const nodeLabels = useMemo(() => parseAllNodeLabels(dot ?? ""), [dot]);

  // Auto-open the detail panel on the last failed step when a run ends in failure.
  const computedStatus = runState?.computedStatus;
  useEffect(() => {
    if (selectedHistoryIndex !== null) return;  // don't override an active selection
    if (userClosedRef.current) return;           // user dismissed — respect that
    if (
      computedStatus !== "failed" &&
      computedStatus !== "stalled" &&
      computedStatus !== "interrupted"
    ) return;
    // Find the last failed entry in history
    let lastFailIndex = -1;
    stageHistory.forEach((v, i) => { if (v.status === "fail") lastFailIndex = i; });
    if (lastFailIndex >= 0) { setPendingNodeId(null); setSelectedHistoryIndex(lastFailIndex); }
  }, [stageHistory, computedStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive graph node colorings from stageHistory (most recent status per node)
  const nodeLastVisit = new Map<string, { status: string; index: number }>();
  stageHistory.forEach((v, i) => nodeLastVisit.set(v.node_id, { status: v.status, index: i }));
  const completedNodes = [...nodeLastVisit.entries()].filter(([, v]) => v.status === "pass").map(([k]) => k);
  const failedNodes = [...nodeLastVisit.entries()].filter(([, v]) => v.status === "fail").map(([k]) => k);
  const highlightNode = [...nodeLastVisit.entries()].find(([, v]) => v.status === "running")?.[0];

  // Cycle node detection: nodes that form the repeated loop.
  // Only highlight cycles once they reach n-1 occurrences before failure.
  // Yellow at n-1 (warning), orange after the run fails.
  const cycleInfo = runState?.cycleInfo;
  const runFailed = computedStatus === "failed" || computedStatus === "stalled" || computedStatus === "interrupted";
  const cycleVisible = cycleInfo != null && cycleInfo.signatureCount >= cycleInfo.signatureLimit - 1;
  const cycleNodes = (() => {
    if (!cycleVisible || !cycleInfo) return undefined;
    const mainHistory = stageHistory.filter((v) => !v.fan_out_node);

    // If we know the retry_target, identify the exact loop by finding the first
    // two consecutive visits to retry_target and collecting everything between them.
    if (cycleInfo.retryTargetNodeId) {
      const retryTarget = cycleInfo.retryTargetNodeId;
      const firstVisit = mainHistory.findIndex((v) => v.node_id === retryTarget);
      const secondVisit = mainHistory.findIndex((v, i) => i > firstVisit && v.node_id === retryTarget);
      if (firstVisit >= 0 && secondVisit > firstVisit) {
        // Nodes from firstVisit up to (but not including) secondVisit = one complete loop iteration
        const loopNodes = new Set(mainHistory.slice(firstVisit, secondVisit).map((v) => v.node_id));
        loopNodes.add(cycleInfo.failingNodeId); // ensure breaker node is always included
        return [...loopNodes];
      }
    }

    // Fallback: nodes visited ≥2 times that appear before the failing node
    const nodeVisitCount = new Map<string, number>();
    mainHistory.forEach((v) => nodeVisitCount.set(v.node_id, (nodeVisitCount.get(v.node_id) ?? 0) + 1));
    const nodes = [...nodeVisitCount.entries()].filter(([, c]) => c >= 2).map(([id]) => id);
    if (!nodes.includes(cycleInfo.failingNodeId)) nodes.push(cycleInfo.failingNodeId);
    return nodes;
  })();

  // The selected node on the graph = the node_id of the selected history item
  const selectedNodeId = selectedHistoryIndex != null ? stageHistory[selectedHistoryIndex]?.node_id : undefined;

  // Clicking a graph node selects the most recent visit to that node,
  // or shows a pending panel if the node hasn't been reached yet.
  const handleGraphNodeClick = (nodeName: string) => {
    // Toggle off if clicking the already-selected node
    if (selectedHistoryIndex != null && selectedNodeId === nodeName) {
      userClosedRef.current = true;
      setSelectedHistoryIndex(null);
      setPendingNodeId(null);
      return;
    }
    if (pendingNodeId === nodeName) {
      userClosedRef.current = true;
      setPendingNodeId(null);
      return;
    }
    userClosedRef.current = false;
    let lastIndex = -1;
    stageHistory.forEach((v, i) => { if (v.node_id === nodeName) lastIndex = i; });
    if (lastIndex >= 0) {
      setSelectedHistoryIndex(lastIndex);
      setPendingNodeId(null);
    } else {
      setSelectedHistoryIndex(null);
      setPendingNodeId(nodeName);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400 text-sm">
        Loading run {runId}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="text-center space-y-2">
          <div className="text-red-400 text-sm">{error}</div>
          <div className="text-gray-500 text-xs">Run ID: {runId}</div>
        </div>
      </div>
    );
  }

  const panelOpen = selectedHistoryIndex != null || pendingNodeId != null;
  // The node highlighted/selected on the graph — either from history or the pending click
  const graphSelectedNode = selectedNodeId ?? pendingNodeId ?? undefined;

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 shrink-0 bg-gray-900/50">
        <a href="/" className="text-gray-600 hover:text-gray-300 text-xs shrink-0" title="All runs">←</a>
        <span className="text-xs font-mono text-gray-400 truncate max-w-xs" title={runId}>{runId}</span>
        {runState && <StatusBadge status={runState.computedStatus} />}
        {run?.dot_file && <span className="text-xs text-gray-500">{run.dot_file}</span>}
        {run?.last_heartbeat && <HeartbeatAge lastHeartbeat={run.last_heartbeat} />}
        <div className="ml-auto flex items-center gap-2">
          {runState?.worktreePath && (
            <button
              onClick={() => setWorkspaceOpen((v) => !v)}
              title="Browse workspace files"
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                workspaceOpen
                  ? "bg-blue-600/20 border-blue-500/50 text-blue-300"
                  : "border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600"
              }`}
            >
              workspace
            </button>
          )}
          <span
            className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
          {run?.failure_reason && !cycleInfo && (
            <span className="text-xs text-red-400 truncate max-w-xs" title={run.failure_reason}>
              {run.failure_reason}
            </span>
          )}
        </div>
      </div>
      {/* Cycle banner — yellow at n-1 warning, orange after failure */}
      {cycleVisible && cycleInfo && (
        <div className="shrink-0">
          {/* Banner row */}
          <div className={`flex items-center gap-2 px-4 py-1.5 border-b ${
            runFailed ? "border-orange-800/40 bg-orange-950/40" : "border-yellow-800/40 bg-yellow-950/30"
          }`}>
            <span className={`text-xs font-semibold shrink-0 ${runFailed ? "text-orange-400" : "text-yellow-400"}`}>
              ⟳ Deterministic cycle
            </span>
            <span className={runFailed ? "text-orange-700" : "text-yellow-700"}>·</span>
            <span className={`text-xs font-mono truncate min-w-0 ${runFailed ? "text-orange-500/90" : "text-yellow-500/90"}`} title={cycleInfo.signature}>
              {cycleInfo.signature}
            </span>
            <span className={`ml-auto text-xs shrink-0 tabular-nums ${runFailed ? "text-orange-600" : "text-yellow-600"}`}>
              repeated {cycleInfo.signatureCount}/{cycleInfo.signatureLimit}×
            </span>
            {cycleNodes && cycleNodes.length > 0 && (
              <button
                onClick={() => setCycleMenuOpen((v) => !v)}
                className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                  cycleMenuOpen
                    ? runFailed ? "border-orange-600/60 bg-orange-900/40 text-orange-300" : "border-yellow-600/60 bg-yellow-900/40 text-yellow-300"
                    : runFailed ? "border-orange-800/40 text-orange-600 hover:text-orange-400 hover:border-orange-600/40" : "border-yellow-800/40 text-yellow-600 hover:text-yellow-400 hover:border-yellow-600/40"
                }`}
              >
                {cycleMenuOpen ? "▴" : "▾"} {cycleNodes.length} steps
              </button>
            )}
          </div>

          {/* Expanded step list */}
          {cycleMenuOpen && cycleNodes && cycleNodes.length > 0 && (
            <div className={`border-b ${runFailed ? "border-orange-800/20 bg-orange-950/20" : "border-yellow-800/20 bg-yellow-950/10"}`}>
              {cycleNodes.map((nodeId) => {
                // Most recent non-branch visit to this node
                let lastIndex = -1;
                stageHistory.forEach((v, i) => { if (v.node_id === nodeId && !v.fan_out_node) lastIndex = i; });
                if (lastIndex === -1) return null;
                const visit = stageHistory[lastIndex];
                const isFailing = nodeId === cycleInfo.failingNodeId;
                const icon = visit.status === "pass" ? "✓" : visit.status === "fail" ? "✗" : "●";
                const iconCls = visit.status === "pass" ? "text-green-400" : visit.status === "fail" ? "text-red-400" : "text-amber-400 animate-pulse";
                const dur = visit.duration_s != null
                  ? (visit.duration_s < 60 ? `${visit.duration_s}s` : `${Math.floor(visit.duration_s / 60)}m ${visit.duration_s % 60}s`)
                  : "";
                return (
                  <button
                    key={nodeId}
                    onClick={() => { userClosedRef.current = false; setPendingNodeId(null); setSelectedHistoryIndex(lastIndex); }}
                    className={`w-full text-left flex items-start gap-2 px-4 py-1 hover:bg-white/5 transition-colors ${isFailing ? "bg-red-950/20" : ""}`}
                  >
                    <span className={`text-xs mt-0.5 shrink-0 w-3 text-center ${iconCls}`}>{icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className={`text-xs font-mono truncate ${isFailing ? (runFailed ? "text-orange-300" : "text-yellow-300") : "text-gray-300"}`}>
                          {nodeLabels.get(nodeId) ?? nodeId}
                        </span>
                        {isFailing && (
                          <span className={`text-[9px] shrink-0 ${runFailed ? "text-orange-600" : "text-yellow-600"}`}>← failing</span>
                        )}
                        {dur && <span className="ml-auto text-[10px] text-gray-600 tabular-nums shrink-0">{dur}</span>}
                      </div>
                      {visit.failure_reason && (
                        <div className="text-[10px] text-red-400/60 truncate">{visit.failure_reason}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        {run && (
          <StageSidebar
            run={run}
            stages={stages}
            stageHistory={stageHistory}
            selectedHistoryIndex={selectedHistoryIndex}
            onSelectVisit={(idx) => { setPendingNodeId(null); setSelectedHistoryIndex(idx); }}
            onHoverVisit={setHoveredHistoryIndex}
            restartCount={runState?.restartCount}
            restartKinds={runState?.restartKinds}
            nodeLabels={nodeLabels}
          />
        )}

        {/* Center: DOT graph */}
        <div className="flex-1 min-w-0">
          {dot ? (
            <DotPreview
              dot={dot}
              className="h-full"
              completedNodes={completedNodes}
              failedNodes={failedNodes}
              cycleNodes={cycleNodes}
              cycleResolved={runFailed}
              highlightNode={highlightNode}
              selectedNode={graphSelectedNode}
              onNodeClick={handleGraphNodeClick}
              stageHistory={stageHistory}
              hoveredHistoryIndex={hoveredHistoryIndex}
              edgeToEdge
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              {run ? (
                <div className="text-center space-y-1">
                  <div>No DOT graph available</div>
                  <div className="text-xs text-gray-700">
                    DOT graph not found in run manifest
                  </div>
                </div>
              ) : (
                <div>Waiting for run data…</div>
              )}
            </div>
          )}
        </div>

        {/* Right panel: stage details (slide-in) */}
        <div
          className={`h-full overflow-hidden transition-all duration-200 ease-in-out ${
            panelOpen ? "translate-x-0" : "translate-x-full w-0"
          }`}
        >
          {run && selectedHistoryIndex != null && (
            <StageDetailPanel
              run={run}
              stageHistory={stageHistory}
              selectedHistoryIndex={selectedHistoryIndex}
              onSelectVisit={(idx) => { userClosedRef.current = false; setSelectedHistoryIndex(idx); setPendingNodeId(null); }}
              onClose={() => { userClosedRef.current = true; setSelectedHistoryIndex(null); setPendingNodeId(null); }}
              dot={dot}
              nodeLabels={nodeLabels}
            />
          )}
          {pendingNodeId && selectedHistoryIndex == null && (
            <div className="w-96 h-full border-l border-gray-800 flex flex-col shrink-0 bg-gray-900/30">
              <div className="border-b border-gray-800 px-3 py-2 shrink-0 flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-gray-200 truncate font-medium">{nodeLabels.get(pendingNodeId) ?? pendingNodeId}</span>
                <button
                  onClick={() => { userClosedRef.current = true; setPendingNodeId(null); }}
                  className="text-gray-500 hover:text-gray-200 text-xs px-2 py-1 rounded hover:bg-gray-800 shrink-0"
                >✕</button>
              </div>
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-1">
                  <div className="text-xs text-gray-500">Not yet executed</div>
                  <div className="text-[10px] text-gray-700">This node hasn't run in this execution</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Workspace panel (slide-in from right) */}
        {workspaceOpen && runId && (
          <WorkspacePanel
            runId={runId}
            isExecuting={runState?.computedStatus === "executing"}
            onClose={() => setWorkspaceOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
