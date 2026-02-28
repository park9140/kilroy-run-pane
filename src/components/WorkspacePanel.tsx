import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

interface WorkspaceData {
  files: WorkspaceFile[];
  worktreePath: string;
}

interface WorkspacePanelProps {
  runId: string;
  isExecuting: boolean;
  onClose: () => void;
}

function fileIcon(name: string): string {
  if (name.endsWith(".md")) return "📄";
  if (name.endsWith(".json")) return "{}";
  if (name.endsWith(".sh")) return "⚙";
  if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".js")) return "⌥";
  return "·";
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

function formatAge(mtime: number): string {
  const s = Math.floor((Date.now() - mtime) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function JsonViewer({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content);
    return (
      <pre className="text-[11px] font-mono text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    return (
      <pre className="text-[11px] font-mono text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
        {content}
      </pre>
    );
  }
}

function MarkdownViewer({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none text-gray-300 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_h1]:text-gray-200 [&_h2]:text-gray-200 [&_h3]:text-gray-300 [&_code]:text-[10px] [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_p]:text-[11px] [&_li]:text-[11px] [&_a]:text-blue-400">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function PlainViewer({ content }: { content: string }) {
  return (
    <pre className="text-[11px] font-mono text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
      {content}
    </pre>
  );
}

function FileContentViewer({ content, fileName }: { content: string; fileName: string }) {
  if (fileName.endsWith(".md")) return <MarkdownViewer content={content} />;
  if (fileName.endsWith(".json")) return <JsonViewer content={content} />;
  return <PlainViewer content={content} />;
}

export function WorkspacePanel({ runId, isExecuting, onClose }: WorkspacePanelProps) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/workspace`);
      if (!res.ok) {
        if (res.status === 404) { setError("No worktree available for this run."); return; }
        setError(`Error ${res.status}`);
        return;
      }
      const d = await res.json() as WorkspaceData;
      setData(d);
      setError(null);
      // Auto-select work_queue.json or spec.md if nothing selected yet
      if (!selectedPath && d.files.length > 0) {
        const preferred = d.files.find((f) => f.name === "work_queue.json" || f.name === "spec.md");
        const toSelect = preferred ?? d.files[0];
        setSelectedPath(toSelect.path);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [runId, selectedPath]);

  // Initial load + auto-refresh while executing
  useEffect(() => {
    fetchFiles();
    if (!isExecuting) return;
    const id = setInterval(fetchFiles, 4000);
    return () => clearInterval(id);
  }, [fetchFiles, isExecuting]);

  // Load file content when selection changes
  useEffect(() => {
    if (!selectedPath) { setFileContent(null); return; }
    setLoadingContent(true);
    fetch(`/api/runs/${runId}/workspace/file?path=${encodeURIComponent(selectedPath)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then((text) => { setFileContent(text); setLoadingContent(false); })
      .catch((e) => { setFileContent(`Error loading file: ${e}`); setLoadingContent(false); });
  }, [runId, selectedPath]);

  // Auto-refresh content while executing
  useEffect(() => {
    if (!isExecuting || !selectedPath) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/api/runs/${runId}/workspace/file?path=${encodeURIComponent(selectedPath)}`);
        if (r.ok) setFileContent(await r.text());
      } catch { /* ok */ }
    }, 4000);
    return () => clearInterval(id);
  }, [runId, selectedPath, isExecuting]);

  const selectedFile = data?.files.find((f) => f.path === selectedPath);

  return (
    <div className="w-[480px] h-full border-l border-gray-800 flex flex-col shrink-0 bg-gray-900/30">
      {/* Header */}
      <div className="border-b border-gray-800 px-3 py-2 shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-gray-200">Workspace</span>
          {isExecuting && (
            <span className="text-[9px] text-amber-400 animate-pulse">● live</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-200 text-xs px-2 py-1 rounded hover:bg-gray-800 shrink-0"
        >✕</button>
      </div>

      {error ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-1">
            <div className="text-xs text-gray-500">{error}</div>
          </div>
        </div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-gray-600">Loading…</div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* File list */}
          <div className="shrink-0 border-b border-gray-800 max-h-44 overflow-y-auto">
            {data.files.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-600">No files found</div>
            ) : (
              data.files.map((f) => {
                const isSelected = f.path === selectedPath;
                return (
                  <button
                    key={f.path}
                    onClick={() => setSelectedPath(f.path)}
                    className={`w-full text-left flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800/60 transition-colors border-l-2 ${
                      isSelected
                        ? "bg-gray-700/50 border-blue-500"
                        : "border-transparent"
                    }`}
                  >
                    <span className="text-[10px] text-gray-500 font-mono w-4 shrink-0 text-center">
                      {fileIcon(f.name)}
                    </span>
                    <span className={`text-xs font-mono truncate flex-1 ${isSelected ? "text-gray-100" : "text-gray-300"}`}>
                      {f.path}
                    </span>
                    <span className="text-[9px] text-gray-600 shrink-0 tabular-nums">
                      {fmtSize(f.size)}
                    </span>
                    <span className="text-[9px] text-gray-700 shrink-0 tabular-nums">
                      {formatAge(f.mtime)}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* File content */}
          <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
            {!selectedPath ? (
              <div className="text-xs text-gray-600">Select a file to view</div>
            ) : loadingContent ? (
              <div className="text-xs text-gray-600">Loading…</div>
            ) : fileContent !== null ? (
              <div>
                <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-gray-800/50 shrink-0">
                  <span className="text-[10px] font-mono text-gray-400 flex-1 truncate">{selectedFile?.path}</span>
                  {selectedFile && (
                    <span className="text-[9px] text-gray-600 shrink-0 tabular-nums">
                      {fmtSize(selectedFile.size)} · {formatAge(selectedFile.mtime)} ago
                    </span>
                  )}
                </div>
                <FileContentViewer content={fileContent} fileName={selectedFile?.name ?? ""} />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
