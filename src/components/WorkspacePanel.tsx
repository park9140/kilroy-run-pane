import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

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
  if (name.endsWith(".md")) return "M↓";
  if (name.endsWith(".json")) return "{}";
  if (name.endsWith(".sh")) return "sh";
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "ts";
  if (name.endsWith(".js") || name.endsWith(".jsx")) return "js";
  if (name.endsWith(".py")) return "py";
  if (name.endsWith(".go")) return "go";
  if (name.endsWith(".rs")) return "rs";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "ym";
  if (name.endsWith(".toml")) return "tm";
  if (name.endsWith(".dot")) return "gv";
  return "·";
}

// ── Tree building ──────────────────────────────────────────────────────────

interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeItem[];
}

interface FileNode {
  type: "file";
  name: string;
  path: string;
  file: WorkspaceFile;
}

type TreeItem = DirNode | FileNode;

function buildTree(files: WorkspaceFile[]): TreeItem[] {
  const root: TreeItem[] = [];
  const dirMap = new Map<string, DirNode>();

  for (const file of files) {
    const parts = file.path.split("/");
    let children = root;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      currentPath = currentPath ? `${currentPath}/${dirName}` : dirName;
      let dir = dirMap.get(currentPath);
      if (!dir) {
        dir = { type: "dir", name: dirName, path: currentPath, children: [] };
        dirMap.set(currentPath, dir);
        children.push(dir);
      }
      children = dir.children;
    }
    children.push({ type: "file", name: parts[parts.length - 1], path: file.path, file });
  }
  return root;
}

function TreeView({
  items, expandedDirs, onToggleDir, selectedPath, onSelectFile, depth = 0,
}: {
  items: TreeItem[];
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  depth?: number;
}) {
  return (
    <>
      {items.map((item) => {
        if (item.type === "dir") {
          const isExpanded = expandedDirs.has(item.path);
          return (
            <div key={item.path}>
              <button
                onClick={() => onToggleDir(item.path)}
                style={{ paddingLeft: `${depth * 10 + 6}px` }}
                className="w-full text-left flex items-center gap-1 py-0.5 pr-2 hover:bg-gray-800/40 transition-colors"
              >
                <span className="text-[9px] text-gray-600 shrink-0 w-3">{isExpanded ? "▾" : "▸"}</span>
                <span className="text-[10px] font-mono text-gray-500">{item.name}/</span>
              </button>
              {isExpanded && (
                <TreeView
                  items={item.children}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  selectedPath={selectedPath}
                  onSelectFile={onSelectFile}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        } else {
          const isSelected = item.path === selectedPath;
          return (
            <button
              key={item.path}
              onClick={() => onSelectFile(item.path)}
              style={{ paddingLeft: `${depth * 10 + 6}px` }}
              className={`w-full text-left flex items-center gap-1.5 py-0.5 pr-2 border-l-2 transition-colors ${
                isSelected ? "border-blue-500 bg-gray-700/50" : "border-transparent hover:bg-gray-800/40"
              }`}
            >
              <span className="text-[8px] text-gray-600 font-mono w-5 shrink-0 text-right">{fileIcon(item.name)}</span>
              <span className={`text-[10px] font-mono truncate flex-1 ${isSelected ? "text-gray-100" : "text-gray-400"}`}>
                {item.name}
              </span>
              <span className="text-[9px] text-gray-700 shrink-0 tabular-nums">{fmtSize(item.file.size)}</span>
            </button>
          );
        }
      })}
    </>
  );
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

// Markdown components with good code block formatting
const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const isBlock = className?.startsWith("language-");
    const lang = className?.replace("language-", "") ?? "";
    if (isBlock) {
      return (
        <div className="my-2 rounded border border-gray-700 overflow-hidden">
          {lang && (
            <div className="px-2 py-0.5 bg-gray-800 text-[9px] text-gray-500 font-mono border-b border-gray-700">
              {lang}
            </div>
          )}
          <pre className="overflow-x-auto p-3 bg-gray-900">
            <code className="text-[11px] font-mono text-gray-200 whitespace-pre">{children}</code>
          </pre>
        </div>
      );
    }
    return (
      <code
        className="text-[10px] font-mono bg-gray-800 text-amber-300 px-1 py-0.5 rounded"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    // Let our code component handle pre+code; bare pre blocks get plain styling
    return <>{children}</>;
  },
  h1({ children }) {
    return <h1 className="text-sm font-semibold text-gray-100 mt-3 mb-1.5 border-b border-gray-800 pb-1">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-xs font-semibold text-gray-200 mt-2.5 mb-1">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-xs font-medium text-gray-300 mt-2 mb-0.5">{children}</h3>;
  },
  p({ children }) {
    return <p className="text-[11px] text-gray-300 my-1 leading-relaxed">{children}</p>;
  },
  ul({ children }) {
    return <ul className="list-disc list-inside text-[11px] text-gray-300 my-1 space-y-0.5 pl-2">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal list-inside text-[11px] text-gray-300 my-1 space-y-0.5 pl-2">{children}</ol>;
  },
  li({ children }) {
    return <li className="text-[11px] text-gray-300">{children}</li>;
  },
  blockquote({ children }) {
    return <blockquote className="border-l-2 border-gray-600 pl-3 my-1 text-gray-400 italic">{children}</blockquote>;
  },
  a({ href, children }) {
    return <a href={href} className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">{children}</a>;
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-2">
        <table className="text-[10px] text-gray-300 border-collapse border border-gray-700 w-full">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-gray-700 px-2 py-1 bg-gray-800 text-left font-semibold text-gray-200">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-gray-700 px-2 py-1">{children}</td>;
  },
  hr() {
    return <hr className="border-gray-700 my-2" />;
  },
};

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
    <div className="text-gray-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
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

type ViewMode = "rendered" | "raw";

function FileContentViewer({ content, fileName }: { content: string; fileName: string }) {
  const isMarkdown = fileName.endsWith(".md");
  const isJson = fileName.endsWith(".json");
  const [mode, setMode] = useState<ViewMode>("rendered");

  if (isMarkdown) {
    return (
      <div>
        <div className="flex items-center gap-1 mb-2">
          <button
            onClick={() => setMode("rendered")}
            className={`text-[9px] px-1.5 py-0.5 rounded ${mode === "rendered" ? "bg-gray-700 text-gray-200" : "text-gray-600 hover:text-gray-400"}`}
          >
            Rendered
          </button>
          <button
            onClick={() => setMode("raw")}
            className={`text-[9px] px-1.5 py-0.5 rounded ${mode === "raw" ? "bg-gray-700 text-gray-200" : "text-gray-600 hover:text-gray-400"}`}
          >
            Raw
          </button>
        </div>
        {mode === "rendered" ? <MarkdownViewer content={content} /> : <PlainViewer content={content} />}
      </div>
    );
  }

  if (isJson) return <JsonViewer content={content} />;
  return <PlainViewer content={content} />;
}

export function WorkspacePanel({ runId, isExecuting, onClose }: WorkspacePanelProps) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Which directories are expanded in the tree (default: .ai)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set([".ai"]));

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

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
      // Auto-select .ai/work_queue.json, .ai/spec.md, or first file on first load
      if (!selectedPath && d.files.length > 0) {
        const preferred = d.files.find((f) =>
          f.path === ".ai/work_queue.json" || f.path === ".ai/spec.md"
        );
        setSelectedPath((preferred ?? d.files[0]).path);
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

  const handleReveal = () => {
    fetch(`/api/runs/${runId}/workspace/reveal`, { method: "POST" }).catch(() => {});
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/runs/${runId}/workspace/download`);
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workspace-${runId.slice(-8)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Download failed:", e);
    } finally {
      setDownloading(false);
    }
  };

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
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleReveal}
            disabled={!data}
            title="Open worktree in Finder"
            className="text-[10px] px-2 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ⌘ Finder
          </button>
          <button
            onClick={handleDownload}
            disabled={!data || downloading}
            title="Download workspace as zip"
            className="text-[10px] px-2 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {downloading ? "…" : "⬇ zip"}
          </button>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-xs px-2 py-1 rounded hover:bg-gray-800"
          >✕</button>
        </div>
      </div>

      {error ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-gray-500">{error}</div>
        </div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-gray-600">Loading…</div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* File tree */}
          <div className="shrink-0 border-b border-gray-800 max-h-56 overflow-y-auto">
            {data.files.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-600">No files found</div>
            ) : (
              <TreeView
                items={buildTree(data.files)}
                expandedDirs={expandedDirs}
                onToggleDir={toggleDir}
                selectedPath={selectedPath}
                onSelectFile={setSelectedPath}
              />
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
                <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-gray-800/50">
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
