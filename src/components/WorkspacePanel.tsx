import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { VisitedStage } from "../lib/types";
import { apiUrl } from "../lib/embeddedBase";

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

interface CommitInfo {
  sha: string;
  node_id: string;
  status: string;
}

interface BranchInfo {
  name: string;
  sha: string;
}

interface WorkspacePanelProps {
  runId: string;
  isExecuting: boolean;
  selectedVisit?: VisitedStage | null;
  stageHistory?: VisitedStage[];
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

interface FileDiffInfo {
  diff: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
}

/** Parse unified diff text into per-file sections. */
function parseDiffByFile(diffText: string): Map<string, FileDiffInfo> {
  const result = new Map<string, FileDiffInfo>();
  const sections = diffText.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const pathMatch = /^\+\+\+ b\/(.+)$/m.exec(section);
    if (!pathMatch) continue;
    const path = pathMatch[1].trim();
    const status: FileDiffInfo["status"] =
      /^new file mode/m.test(section) ? "added" :
      /^deleted file mode/m.test(section) ? "deleted" : "modified";
    let additions = 0, deletions = 0;
    for (const line of section.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    result.set(path, { diff: section, status, additions, deletions });
  }
  return result;
}

function TreeView({
  items, expandedDirs, onToggleDir, selectedPath, onSelectFile, fileDiffs, depth = 0,
}: {
  items: TreeItem[];
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  fileDiffs: Map<string, FileDiffInfo>;
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
                  fileDiffs={fileDiffs}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        } else {
          const isSelected = item.path === selectedPath;
          const diffInfo = fileDiffs.get(item.path);
          const nameColor = isSelected ? "text-gray-100" :
            diffInfo?.status === "added" ? "text-green-400" :
            diffInfo?.status === "deleted" ? "text-red-400" :
            diffInfo ? "text-amber-300" : "text-gray-400";
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
              <span className={`text-[10px] font-mono truncate flex-1 ${nameColor}`}>
                {item.name}
              </span>
              {diffInfo ? (
                <span className="text-[9px] shrink-0 tabular-nums flex items-center gap-0.5">
                  {diffInfo.additions > 0 && <span className="text-green-500">+{diffInfo.additions}</span>}
                  {diffInfo.deletions > 0 && <span className="text-red-500">-{diffInfo.deletions}</span>}
                </span>
              ) : (
                <span className="text-[9px] text-gray-700 shrink-0 tabular-nums">{fmtSize(item.file.size)}</span>
              )}
            </button>
          );
        }
      })}
    </>
  );
}

// ── Diff viewer ────────────────────────────────────────────────────────────

function DiffViewer({ diff, singleFile = false }: { diff: string; singleFile?: boolean }) {
  if (!diff.trim()) {
    return <div className="text-xs text-gray-500 italic">No changes from HEAD.</div>;
  }

  const lines = diff.split("\n");
  return (
    <div className="font-mono text-[11px] leading-relaxed overflow-x-auto">
      {lines.map((line, i) => {
        if (line.startsWith("diff --git")) {
          if (singleFile) return null;
          return (
            <div key={i} className="text-gray-300 font-semibold mt-3 mb-0.5 pb-0.5 border-b border-gray-700/50 truncate">
              {line.replace(/^diff --git a\/.+ b\//, "")}
            </div>
          );
        }
        if (line.startsWith("--- ") || line.startsWith("+++ ")) {
          return singleFile ? null : <div key={i} className="text-gray-600 truncate">{line}</div>;
        }
        if (line.startsWith("@@")) {
          return (
            <div key={i} className="text-cyan-400/70 bg-cyan-950/20 -mx-3 px-3 mt-1 truncate">
              {line}
            </div>
          );
        }
        if (line.startsWith("+")) {
          return <div key={i} className="text-green-400 bg-green-950/30 -mx-3 px-3 whitespace-pre">{line}</div>;
        }
        if (line.startsWith("-")) {
          return <div key={i} className="text-red-400 bg-red-950/30 -mx-3 px-3 whitespace-pre">{line}</div>;
        }
        if (line.startsWith("index ") || line.startsWith("Binary") || line.startsWith("new file") || line.startsWith("deleted file")) {
          return <div key={i} className="text-gray-600 text-[10px]">{line}</div>;
        }
        return <div key={i} className="text-gray-500 whitespace-pre">{line || " "}</div>;
      })}
    </div>
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

export function WorkspacePanel({ runId, isExecuting, selectedVisit, stageHistory }: WorkspacePanelProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<WorkspaceData | null>(null);
  // Initialize from URL so refreshes restore selection
  const [selectedPath, setSelectedPathState] = useState<string | null>(() => searchParams.get("wsfile"));
  // Stable ref so fetchFiles can read current path without being in its dep array
  const selectedPathRef = useRef<string | null>(null);
  useEffect(() => { selectedPathRef.current = selectedPath; }, [selectedPath]);

  // Wrapper that syncs selection to URL
  const setSelectedPath = useCallback((path: string | null) => {
    setSelectedPathState(path);
    setSearchParams((p) => {
      if (path) p.set("wsfile", path);
      else p.delete("wsfile");
      return p;
    }, { replace: true });
  }, [setSearchParams]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [fileDiffs, setFileDiffs] = useState<Map<string, FileDiffInfo>>(new Map());
  // "diff" shows the git diff for a changed file; "raw" shows its content
  const [fileViewMode, setFileViewMode] = useState<"diff" | "raw">("diff");
  // Which directories are expanded in the tree (default: .ai)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set([".ai"]));

  // ── Commit tracking ────────────────────────────────────────────────────────
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  // pinnedRef: ref used for file tree and content
  const [pinnedRef, setPinnedRef] = useState<string | null>(null);
  // pinnedDiffRef: ref used for the commit-diff endpoint (the "to" side)
  const [pinnedDiffRef, setPinnedDiffRef] = useState<string | null>(null);
  // pinnedDiffBase: optional "from" side for range diffs (fan-out branch work)
  const [pinnedDiffBase, setPinnedDiffBase] = useState<string | null>(null);
  const [pinnedLabel, setPinnedLabel] = useState<string | null>(null);

  // Fetch all run-scoped commits and branch refs once
  useEffect(() => {
    fetch(apiUrl(`/api/runs/${runId}/workspace/commits`))
      .then((r) => r.ok ? r.json() : [])
      .then((data: CommitInfo[]) => setCommits(data))
      .catch(() => {});
    fetch(apiUrl(`/api/runs/${runId}/workspace/branches`))
      .then((r) => r.ok ? r.json() : [])
      .then((data: BranchInfo[]) => setBranches(data))
      .catch(() => {});
  }, [runId]);

  // Resolve the commit for the selected visit
  useEffect(() => {
    if (!selectedVisit || !commits.length || !stageHistory) {
      setPinnedRef(null);
      setPinnedDiffRef(null);
      setPinnedDiffBase(null);
      setPinnedLabel(null);
      return;
    }
    // Try the node's own commit first (works for both main and branch nodes
    // since git log --all includes orphaned branch commits).
    let visitNum = 0;
    for (const v of stageHistory) {
      if (v.node_id === selectedVisit.node_id) visitNum++;
      if (v === selectedVisit) break;
    }
    let nodeCommits = commits.filter((c) => c.node_id === selectedVisit.node_id);
    let commit = nodeCommits[visitNum - 1];

    // For fan-out branch visits, try to find the branch's git ref and diff
    // against the fan-out orchestrator's commit (showing all branch work).
    if (selectedVisit.fan_out_node && selectedVisit.branch_key && selectedVisit.stage_path) {
      // Construct expected branch ref from stage_path:
      //   stage_path: "parallel/dod_fanout/01-dod_design/dod_design"
      //   → branch: "attractor/run/parallel/<runId>/dod_fanout/dod_design"
      //   With pass: "parallel/plan_fanout/pass4/05-plan_product/plan_product"
      //   → branch: "attractor/run/parallel/<runId>/plan_fanout/pass4/plan_product"
      const pathParts = selectedVisit.stage_path.split("/");
      const fanoutGroup = pathParts[1]; // e.g. "dod_fanout"
      const hasPass = pathParts[2]?.startsWith("pass");
      const branchRefSuffix = hasPass
        ? `${fanoutGroup}/${pathParts[2]}/${selectedVisit.branch_key}`
        : `${fanoutGroup}/${selectedVisit.branch_key}`;
      const expectedRef = `attractor/run/parallel/${runId}/${branchRefSuffix}`;
      const branch = branches.find((b) => b.name === expectedRef);

      if (branch) {
        // Find the fan-out orchestrator's commit as the diff base
        let fanoutVisitNum = 0;
        for (const v of stageHistory) {
          if (v.node_id === selectedVisit.fan_out_node && !v.fan_out_node) fanoutVisitNum++;
          if (v === selectedVisit) break;
        }
        const fanoutCommits = commits.filter((c) => c.node_id === selectedVisit.fan_out_node);
        const fanoutCommit = fanoutCommits[fanoutVisitNum - 1];

        // File tree at branch tip (shows state after branch work)
        setPinnedRef(branch.sha);
        // Diff from fan-out commit to branch tip (shows what this branch changed)
        setPinnedDiffRef(branch.sha);
        setPinnedDiffBase(fanoutCommit?.sha ?? null);
        const baseShort = fanoutCommit ? fanoutCommit.sha.slice(0, 7) : "root";
        setPinnedLabel(`${baseShort}..${branch.sha.slice(0, 7)} ${selectedVisit.branch_key}`);
        return;
      }
    }

    // Fallback for non-branch nodes or when branch ref not found:
    // use the fan-out parent's commit if the node has no own commit.
    if (!commit && selectedVisit.fan_out_node) {
      visitNum = 0;
      for (const v of stageHistory) {
        if (v.node_id === selectedVisit.fan_out_node && !v.fan_out_node) visitNum++;
        if (v === selectedVisit) break;
      }
      nodeCommits = commits.filter((c) => c.node_id === selectedVisit.fan_out_node);
      commit = nodeCommits[visitNum - 1];
      if (commit) {
        setPinnedRef(`${commit.sha}^`);
        setPinnedDiffRef(commit.sha);
        setPinnedDiffBase(null);
        setPinnedLabel(`${commit.sha.slice(0, 7)}^ ${selectedVisit.node_id}`);
        return;
      }
    }

    if (commit) {
      setPinnedRef(commit.sha);
      setPinnedDiffRef(commit.sha);
      setPinnedDiffBase(null);
      const fullIndex = commits.indexOf(commit);
      const prevCommit = fullIndex > 0 ? commits[fullIndex - 1] : null;
      const startShort = prevCommit ? prevCommit.sha.slice(0, 7) : "root";
      setPinnedLabel(`${startShort}..${commit.sha.slice(0, 7)} ${selectedVisit.node_id}`);
    } else {
      setPinnedRef(null);
      setPinnedDiffRef(null);
      setPinnedDiffBase(null);
      setPinnedLabel(null);
    }
  }, [selectedVisit, commits, branches, stageHistory, runId]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const fetchFiles = useCallback(async (ref: string | null) => {
    try {
      const url = ref
        ? apiUrl(`/api/runs/${runId}/workspace?ref=${encodeURIComponent(ref)}`)
        : apiUrl(`/api/runs/${runId}/workspace`);
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) { setError("No worktree available for this run."); return; }
        setError(`Error ${res.status}`);
        return;
      }
      const d = await res.json() as WorkspaceData;
      setData(d);
      setError(null);
      // Maintain the current path if it still exists; otherwise auto-select a preferred file
      const currentPath = selectedPathRef.current;
      if (currentPath && d.files.some((f) => f.path === currentPath)) {
        // path still valid — keep it (no setSelectedPath needed)
      } else if (d.files.length > 0) {
        const preferred = d.files.find((f) =>
          f.path === ".ai/work_queue.json" || f.path === ".ai/spec.md"
        );
        setSelectedPath((preferred ?? d.files[0]).path);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [runId, setSelectedPath]); // selectedPath intentionally excluded — read via selectedPathRef

  // Reload file tree when switching to a pinned commit; clear stale content but preserve path
  // Note: when pinnedRef is null (live mode), effect below handles the fetch instead
  useEffect(() => {
    setFileContent(null);
    if (pinnedRef) fetchFiles(pinnedRef);
  }, [pinnedRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial load + auto-refresh while executing (only in live/HEAD mode)
  useEffect(() => {
    if (pinnedRef) return; // pinned commits are immutable — no polling needed
    fetchFiles(null);
    if (!isExecuting) return;
    const id = setInterval(() => fetchFiles(null), 4000);
    return () => clearInterval(id);
  }, [fetchFiles, isExecuting, pinnedRef]);

  // Load file content when selection or pinnedRef changes
  useEffect(() => {
    if (!selectedPath) { setFileContent(null); return; }
    setLoadingContent(true);
    const refPart = pinnedRef ? `&ref=${encodeURIComponent(pinnedRef)}` : "";
    fetch(apiUrl(`/api/runs/${runId}/workspace/file?path=${encodeURIComponent(selectedPath)}${refPart}`))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then((text) => { setFileContent(text); setLoadingContent(false); })
      .catch((e) => { setFileContent(`Error loading file: ${e}`); setLoadingContent(false); });
  }, [runId, selectedPath, pinnedRef]);

  // Auto-refresh content while executing (only in live/HEAD mode)
  useEffect(() => {
    if (!isExecuting || !selectedPath || pinnedRef) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(apiUrl(`/api/runs/${runId}/workspace/file?path=${encodeURIComponent(selectedPath)}`));
        if (r.ok) setFileContent(await r.text());
      } catch { /* ok */ }
    }, 4000);
    return () => clearInterval(id);
  }, [runId, selectedPath, isExecuting, pinnedRef]);

  const fetchDiff = useCallback(async (ref: string | null, from: string | null) => {
    try {
      let url: string;
      if (ref) {
        url = apiUrl(`/api/runs/${runId}/workspace/commit-diff?ref=${encodeURIComponent(ref)}`);
        if (from) url += `&from=${encodeURIComponent(from)}`;
      } else {
        url = apiUrl(`/api/runs/${runId}/workspace/diff`);
      }
      const res = await fetch(url);
      if (res.ok) setFileDiffs(parseDiffByFile(await res.text()));
    } catch { /* ignore */ }
  }, [runId]);

  // Fetch diff whenever pinnedDiffRef/pinnedDiffBase changes, and auto-refresh while executing in live mode
  useEffect(() => {
    fetchDiff(pinnedDiffRef, pinnedDiffBase);
    if (pinnedDiffRef || !isExecuting) return; // pinned = immutable; stop polling
    const id = setInterval(() => fetchDiff(null, null), 4000);
    return () => clearInterval(id);
  }, [fetchDiff, isExecuting, pinnedDiffRef, pinnedDiffBase]);

  // Auto-expand directories that contain changed files
  useEffect(() => {
    if (fileDiffs.size === 0) return;
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const path of fileDiffs.keys()) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          next.add(parts.slice(0, i).join("/"));
        }
      }
      return next;
    });
  }, [fileDiffs]);

  // When pinned to a commit and its diff loads, auto-select the first changed file —
  // but only when there is no existing selection (e.g. initial page load without ?wsfile).
  // If the user (or a prior auto-select) already chose a file, preserve it; fetchFiles
  // handles the case where that file doesn't exist at the new ref.
  useEffect(() => {
    if (!pinnedDiffRef || fileDiffs.size === 0) return;
    if (selectedPathRef.current) return; // preserve existing selection across node/visit switches
    const firstChanged = [...fileDiffs.keys()][0];
    if (firstChanged) {
      setSelectedPath(firstChanged);
      setFileViewMode("diff");
    }
  }, [pinnedDiffRef, fileDiffs.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch to diff view automatically when selecting a changed file (also reacts to fileDiffs loading)
  useEffect(() => {
    setFileViewMode(selectedPath && fileDiffs.has(selectedPath) ? "diff" : "raw");
  }, [selectedPath, fileDiffs]);

  const handleReveal = () => {
    fetch(apiUrl(`/api/runs/${runId}/workspace/reveal`), { method: "POST" }).catch(() => {});
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(apiUrl(`/api/runs/${runId}/workspace/download`));
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
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Slim toolbar: pinned commit badge + actions */}
      <div className="shrink-0 border-b border-gray-800/50 px-3 py-1 flex items-center gap-2">
        {pinnedLabel ? (
          <span className="text-[9px] font-mono text-violet-400 truncate" title={pinnedLabel}>
            @ {pinnedLabel}
          </span>
        ) : isExecuting ? (
          <span className="text-[9px] text-amber-400 animate-pulse">● live</span>
        ) : (
          <span className="text-[9px] text-gray-600">HEAD</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleReveal}
            disabled={!data}
            title="Open worktree in file manager"
            className="text-[9px] px-1.5 py-0.5 rounded border border-gray-800 text-gray-600 hover:text-gray-300 hover:border-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ⌘ folder
          </button>
          <button
            onClick={handleDownload}
            disabled={!data || downloading}
            title="Download workspace as zip"
            className="text-[9px] px-1.5 py-0.5 rounded border border-gray-800 text-gray-600 hover:text-gray-300 hover:border-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {downloading ? "…" : "⬇ zip"}
          </button>
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
                fileDiffs={fileDiffs}
              />
            )}
          </div>

          {/* File content / diff */}
          <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
            {!selectedPath ? (
              <div className="text-xs text-gray-600">Select a file to view</div>
            ) : (() => {
              const diffInfo = fileDiffs.get(selectedPath);
              return (
                <div>
                  {/* Header row */}
                  <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-gray-800/50">
                    <span className="text-[10px] font-mono text-gray-400 flex-1 truncate">{selectedFile?.path}</span>
                    {diffInfo && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => setFileViewMode("diff")}
                          className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${fileViewMode === "diff" ? "bg-gray-700 text-gray-200" : "text-gray-600 hover:text-gray-400"}`}
                        >Diff</button>
                        <button
                          onClick={() => setFileViewMode("raw")}
                          className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${fileViewMode === "raw" ? "bg-gray-700 text-gray-200" : "text-gray-600 hover:text-gray-400"}`}
                        >Raw</button>
                      </div>
                    )}
                    {!diffInfo && selectedFile && (
                      <span className="text-[9px] text-gray-600 shrink-0 tabular-nums">
                        {fmtSize(selectedFile.size)} · {formatAge(selectedFile.mtime)} ago
                      </span>
                    )}
                  </div>
                  {/* Body */}
                  {diffInfo && fileViewMode === "diff" ? (
                    <DiffViewer diff={diffInfo.diff} singleFile />
                  ) : loadingContent ? (
                    <div className="text-xs text-gray-600">Loading…</div>
                  ) : fileContent !== null ? (
                    <FileContentViewer content={fileContent} fileName={selectedFile?.name ?? ""} />
                  ) : null}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
