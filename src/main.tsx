import { StrictMode, useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { KilroyRunViewer } from "./components/KilroyRunViewer";
import { DotDropOverlay } from "./components/DotDropOverlay";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DotDropOverlay>
      <BrowserRouter>
        <Routes>
          <Route path="/run/:runId" element={<KilroyRunViewer />} />
          <Route path="/" element={<RunPicker />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </DotDropOverlay>
  </StrictMode>
);

interface RunSummary {
  id: string;
  graph_name: string | null;
  repo: string | null;
  goal: string | null;
  started_at: string | null;
  status: string;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusDot(status: string): { color: string; label: string } {
  switch (status) {
    case "completed": return { color: "bg-green-500", label: "Completed" };
    case "failed": return { color: "bg-red-500", label: "Failed" };
    case "interrupted": return { color: "bg-orange-400", label: "Interrupted" };
    case "running": return { color: "bg-amber-400 animate-pulse", label: "Running" };
    default: return { color: "bg-gray-600", label: status };
  }
}

/** Very simple fuzzy match: all query words must appear in the target string */
function fuzzyMatch(target: string, query: string): boolean {
  if (!query) return true;
  const t = target.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => t.includes(word));
}

function RunPicker() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-base font-semibold text-gray-200 mb-5">Kilroy Runs</h1>
        <RunList />
      </div>
    </div>
  );
}

function RunList() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetch("/api/runs/summaries")
      .then((r) => r.json())
      .then((d: { runs?: RunSummary[] }) => {
        // Sort by started_at desc (fall back to id order which is ULID time-ordered)
        const sorted = (d.runs ?? []).slice().sort((a, b) => {
          if (a.started_at && b.started_at)
            return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
          return b.id > a.id ? 1 : -1;
        });
        setRuns(sorted);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Refresh time-ago every 30s
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return runs;
    return runs.filter((r) => {
      const searchable = [r.id, r.graph_name, r.repo, r.goal].filter(Boolean).join(" ");
      return fuzzyMatch(searchable, query);
    });
  }, [runs, query]);

  if (loading) return <div className="text-gray-500 text-sm">Loading runs…</div>;

  return (
    <div className="space-y-3">
      {/* Search */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by ID, pipeline, repo, goal…"
        className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
      />

      {filtered.length === 0 && (
        <div className="text-gray-500 text-sm">
          {runs.length === 0 ? "No runs found." : "No runs match the filter."}
        </div>
      )}

      {filtered.map((run) => {
        const dot = statusDot(run.status);
        const ago = run.started_at ? timeAgo(run.started_at) : null;
        // Force re-render via now dependency
        void now;
        return (
          <a
            key={run.id}
            href={`/run/${run.id}`}
            className="block px-4 py-3 bg-gray-900 border border-gray-800 rounded hover:bg-gray-800/80 hover:border-gray-700 transition-colors"
          >
            <div className="flex items-start gap-3">
              {/* Status dot */}
              <div className="mt-1 shrink-0">
                <span
                  className={`block w-2 h-2 rounded-full ${dot.color}`}
                  title={dot.label}
                />
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-baseline gap-2 flex-wrap">
                  {run.graph_name && (
                    <span className="text-sm font-medium text-gray-200">{run.graph_name}</span>
                  )}
                  {run.repo && (
                    <span className="text-xs text-gray-500">{run.repo}</span>
                  )}
                  {ago && (
                    <span className="text-xs text-gray-600 ml-auto shrink-0">{ago}</span>
                  )}
                </div>
                <div className="text-[11px] font-mono text-gray-600">{run.id}</div>
                {run.goal && (
                  <div className="text-xs text-gray-500 line-clamp-1 mt-0.5">{run.goal}</div>
                )}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}
