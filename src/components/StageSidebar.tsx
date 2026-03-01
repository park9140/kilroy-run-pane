import { useEffect, useRef } from "react";
import type { RunRecord, StageInfo, VisitedStage } from "../lib/types";

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function ElapsedTick({ startedAt }: { startedAt: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (!spanRef.current) return;
      const s = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
      spanRef.current.textContent = fmtDuration(s);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return <span ref={spanRef} />;
}

interface StageSidebarProps {
  run: RunRecord;
  stages?: StageInfo[];
  stageHistory?: VisitedStage[];
  selectedHistoryIndex: number | null;
  onSelectVisit: (historyIndex: number) => void;
  onHoverVisit: (historyIndex: number | null) => void;
  restartCount?: number;
  restartKinds?: Record<number, "loop" | "process">;
  nodeLabels?: Map<string, string>;
}

export function StageSidebar({ run, stageHistory, selectedHistoryIndex, onSelectVisit, onHoverVisit, restartCount, restartKinds, nodeLabels }: StageSidebarProps) {
  const selectedNodeId = selectedHistoryIndex != null ? stageHistory?.[selectedHistoryIndex]?.node_id : undefined;
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new history entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stageHistory?.length]);

  // Flatten to render items, inserting restart separators when restartIndex changes
  type RenderItem =
    | { kind: "visit"; visit: VisitedStage; index: number; isChild: boolean }
    | { kind: "restart"; restartIndex: number };
  const renderItems: RenderItem[] = [];
  if (stageHistory) {
    let lastRestartIndex: number | undefined;
    for (let i = 0; i < stageHistory.length; i++) {
      const visit = stageHistory[i];
      const ri = visit.restartIndex ?? 0;
      if (ri > 0 && ri !== lastRestartIndex) {
        renderItems.push({ kind: "restart", restartIndex: ri });
      }
      lastRestartIndex = ri;
      renderItems.push({ kind: "visit", visit, index: i, isChild: visit.fan_out_node != null });
    }
  }

  return (
    <div className="w-56 h-full border-r border-gray-800 flex flex-col shrink-0 overflow-hidden">
      {/* Run Info */}
      <div className="border-b border-gray-800 p-3 shrink-0">
        <h3 className="text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">Run Info</h3>
        <dl className="space-y-1.5 text-xs">
          <div>
            <dt className="text-gray-500">ID</dt>
            <dd className="text-gray-300 font-mono truncate" title={run.id}>{run.id}</dd>
          </div>
          {run.dot_file && (
            <div>
              <dt className="text-gray-500">Pipeline</dt>
              <dd className="text-gray-300 truncate">{run.dot_file}</dd>
            </div>
          )}
          {run.repo && (
            <div>
              <dt className="text-gray-500">Repo</dt>
              <dd className="text-gray-300 truncate">{run.repo}</dd>
            </div>
          )}
          <div>
            <dt className="text-gray-500">Started</dt>
            <dd className="text-gray-300">
              {run.started_at ? new Date(run.started_at).toLocaleString() : "--"}
            </dd>
          </div>
          {run.finished_at && (
            <div>
              <dt className="text-gray-500">Finished</dt>
              <dd className="text-gray-300">{new Date(run.finished_at).toLocaleString()}</dd>
            </div>
          )}
          {run.params && Object.keys(run.params).length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Params</summary>
              <dl className="mt-1 space-y-1 text-xs">
                {Object.entries(run.params).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-gray-500">{k}</dt>
                    <dd className="text-gray-300 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </dl>
      </div>

      {/* Execution History */}
      <div className="flex-1 overflow-auto">
        <h3 className="text-xs font-medium text-gray-400 px-3 py-2 uppercase tracking-wider sticky top-0 bg-gray-950 flex items-center justify-between">
          <span>Execution History</span>
          {restartCount != null && restartCount > 0 && (() => {
            const processCount = restartKinds
              ? Object.values(restartKinds).filter((k) => k === "process").length
              : 0;
            const loopCount = restartCount - processCount;
            return (
              <span className="text-[10px] font-normal normal-case tracking-normal flex items-center gap-1">
                {processCount > 0 && (
                  <span className="text-blue-400/80">⟳ {processCount} restart{processCount !== 1 ? "s" : ""}</span>
                )}
                {loopCount > 0 && (
                  <span className="text-gray-500">↻ {loopCount} loop{loopCount !== 1 ? "s" : ""}</span>
                )}
              </span>
            );
          })()}
        </h3>
        {renderItems.length === 0 ? (
          <div className="text-xs text-gray-500 p-3">No history yet</div>
        ) : (
          <div>
            {renderItems.map((item, renderIdx) => {
              if (item.kind === "restart") {
                const kind = restartKinds?.[item.restartIndex] ?? "loop";
                const isProcess = kind === "process";
                return (
                  <div
                    key={`restart-sep-${item.restartIndex}-${renderIdx}`}
                    className={`flex items-center gap-2 px-3 py-1 border-y mt-0.5 ${
                      isProcess
                        ? "border-blue-800/40 bg-blue-950/30"
                        : "border-gray-700/30 bg-gray-900/40"
                    }`}
                  >
                    <span className={`text-[10px] font-medium ${isProcess ? "text-blue-400/90" : "text-gray-500"}`}>
                      {isProcess ? "⟳ Process restart" : "↻ Loop iteration"} {item.restartIndex}
                    </span>
                  </div>
                );
              }

              const { visit, index, isChild } = item;
              const isSelected = index === selectedHistoryIndex;
              const isNodeSelected = visit.node_id === selectedNodeId && !isSelected;
              const isRunning = visit.status === "running";

              let icon = "–";
              let iconColor = "text-gray-600";
              if (visit.status === "pass") { icon = "✓"; iconColor = "text-green-400"; }
              else if (visit.status === "fail") { icon = "✗"; iconColor = "text-red-400"; }
              else if (isRunning) { icon = "●"; iconColor = "text-amber-400 animate-pulse"; }

              return (
                <button
                  key={`${visit.fan_out_node ?? ""}:${visit.node_id}:${visit.attempt}:${index}`}
                  onClick={() => onSelectVisit(index)}
                  onMouseEnter={() => onHoverVisit(index)}
                  onMouseLeave={() => onHoverVisit(null)}
                  title={visit.failure_reason ?? undefined}
                  className={`w-full text-left flex items-start gap-1.5 hover:bg-gray-800/60 transition-colors ${
                    isChild ? "pl-6 pr-3 py-0.5" : "px-3 py-1"
                  } ${
                    isSelected
                      ? "bg-gray-700/50 border-l-2 border-blue-500"
                      : isNodeSelected
                        ? "border-l-2 border-blue-500/30"
                        : "border-l-2 border-transparent"
                  }`}
                >
                  {isChild && (
                    <span className="text-gray-600 text-[10px] mt-0.5 shrink-0">↳</span>
                  )}
                  <span className={`text-xs mt-0.5 shrink-0 ${iconColor}`}>{icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className={`font-mono truncate ${isChild ? "text-[10px] text-gray-400" : "text-xs text-gray-300"}`}>
                        {nodeLabels?.get(visit.node_id) ?? visit.node_id}
                      </span>
                      <span className="text-[10px] text-gray-500 shrink-0 tabular-nums">
                        {isRunning
                          ? <ElapsedTick startedAt={visit.started_at} />
                          : visit.duration_s != null ? fmtDuration(visit.duration_s) : ""}
                      </span>
                    </div>
                    {!isChild && (
                      <div className="text-[10px] text-gray-600 tabular-nums">
                        {fmtTime(visit.started_at)}
                        {visit.finished_at && ` → ${fmtTime(visit.finished_at)}`}
                      </div>
                    )}
                    {visit.failure_reason && (
                      <div className="text-[10px] text-red-400/70 truncate" title={visit.failure_reason}>
                        {visit.failure_reason}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
