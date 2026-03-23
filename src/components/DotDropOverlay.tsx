import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { DotPreview } from "./DotPreview";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { parseAllNodeLabels, updateNodeAttr } from "../lib/dotUtils";
import { apiUrl } from "../lib/embeddedBase";

interface DotDropOverlayProps {
  children: ReactNode;
}

const HAS_FS_ACCESS = typeof DataTransferItem !== "undefined" &&
  typeof DataTransferItem.prototype.getAsFileSystemHandle === "function";

export function DotDropOverlay({ children }: DotDropOverlayProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dotContent, setDotContent] = useState<string | null>(null);
  const [dotFileName, setDotFileName] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  // Last-saved content for dirty tracking
  const savedContentRef = useRef<string | null>(null);
  const dirty = dotContent !== null && dotContent !== savedContentRef.current;

  // File System Access API handle
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);

  // Debounced DOT content for DotPreview (avoid re-rendering Graphviz on every keystroke)
  const [debouncedDot, setDebouncedDot] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (dotContent === null) {
      setDebouncedDot(null);
      return;
    }
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedDot(dotContent), 300);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [dotContent]);

  const dragCounter = useRef(0);

  const nodeLabels = useMemo(() => parseAllNodeLabels(dotContent ?? ""), [dotContent]);

  // ── Close overlay helper (checks dirty state) ──
  const closeOverlay = useCallback(() => {
    if (dirty) {
      if (!window.confirm("You have unsaved changes. Close anyway?")) return;
    }
    setDotContent(null);
    setDotFileName("");
    setSelectedNode(null);
    setEditingEnabled(false);
    savedContentRef.current = null;
    fileHandleRef.current = null;
  }, [dirty]);

  // ── Drag & drop handlers ──
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    const types = e.dataTransfer?.types;
    if (types && (types.includes("Files") || types.includes("codefiles") || types.includes("resourceurls"))) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  /** Extract a local file path from a VS Code editor drop (no File object). */
  function extractVsCodePath(dt: DataTransfer): string | null {
    // VS Code provides file paths in several MIME types
    const codefiles = dt.getData("codefiles");
    if (codefiles) {
      try {
        const arr = JSON.parse(codefiles) as string[];
        if (arr[0]) return arr[0];
      } catch { /* ignore */ }
    }
    // Fallback: text/plain often contains the absolute path
    const plain = dt.getData("text/plain");
    if (plain && /\.(dot|gv)$/.test(plain) && plain.startsWith("/")) {
      return plain;
    }
    return null;
  }

  function loadFromPath(filePath: string) {
    const fileName = filePath.split("/").pop() ?? filePath;
    setSelectedNode(null);
    setEditingEnabled(false);
    fileHandleRef.current = null;
    fetch(apiUrl(`/api/local-file?path=${encodeURIComponent(filePath)}`))
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
      .then((text) => {
        setDotContent(text);
        setDebouncedDot(text);
        savedContentRef.current = text;
        setDotFileName(fileName);
      })
      .catch((err) => console.error("Failed to load DOT file from path:", err));
  }

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);

    const dt = e.dataTransfer;
    if (!dt) return;

    const file = dt.files[0];

    // Case 1: Native file drop (from Finder / file manager)
    if (file && (file.name.endsWith(".dot") || file.name.endsWith(".gv"))) {
      // Clear previous state on new file drop
      setSelectedNode(null);
      setEditingEnabled(false);
      fileHandleRef.current = null;

      // Try to get a FileSystemFileHandle (must happen synchronously in drop handler)
      const items = dt.items;
      if (HAS_FS_ACCESS && items && items.length > 0) {
        const item = items[0];
        item.getAsFileSystemHandle!().then((handle) => {
          if (handle && handle.kind === "file") {
            fileHandleRef.current = handle;
            handle.getFile().then((f: File) => f.text()).then((text: string) => {
              setDotContent(text);
              setDebouncedDot(text);
              savedContentRef.current = text;
              setDotFileName(file.name);
            });
          }
        }).catch(() => {
          readFileViaReader(file);
        });
      } else {
        readFileViaReader(file);
      }
      return;
    }

    // Case 2: VS Code editor tab / explorer drop (no File, path in metadata)
    const vscodePath = extractVsCodePath(dt);
    if (vscodePath && (vscodePath.endsWith(".dot") || vscodePath.endsWith(".gv"))) {
      loadFromPath(vscodePath);
      return;
    }
  }, []);

  function readFileViaReader(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === "string") {
        setDotContent(text);
        setDebouncedDot(text);
        savedContentRef.current = text;
        setDotFileName(file.name);
      }
    };
    reader.readAsText(file);
  }

  // ── Event listeners ──
  useEffect(() => {
    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  // Escape key: close panel first, then close overlay (only if not dirty)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedNode) {
          setSelectedNode(null);
        } else {
          closeOverlay();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNode, closeOverlay]);

  // beforeunload warning when dirty
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ── Enable editing (request readwrite permission) ──
  const handleEnableEditing = useCallback(async () => {
    const handle = fileHandleRef.current;
    if (!handle) return;
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      setEditingEnabled(true);
    }
  }, []);

  // ── Save to file ──
  const handleSave = useCallback(async () => {
    if (!dotContent) return;
    const handle = fileHandleRef.current;
    if (handle && editingEnabled) {
      setSaving(true);
      try {
        const writable = await handle.createWritable();
        await writable.write(dotContent);
        await writable.close();
        savedContentRef.current = dotContent;
      } finally {
        setSaving(false);
      }
    } else {
      // Fallback: download via Blob URL
      const blob = new Blob([dotContent], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = dotFileName || "graph.dot";
      a.click();
      URL.revokeObjectURL(url);
      savedContentRef.current = dotContent;
    }
  }, [dotContent, editingEnabled, dotFileName]);

  // ── Revert to last saved ──
  const handleRevert = useCallback(() => {
    if (savedContentRef.current !== null) {
      setDotContent(savedContentRef.current);
      setDebouncedDot(savedContentRef.current);
    }
  }, []);

  // ── Attribute change from NodeDetailPanel ──
  const handleAttrChange = useCallback((attrName: string, newValue: string) => {
    if (!dotContent || !selectedNode) return;
    const updated = updateNodeAttr(dotContent, selectedNode, attrName, newValue);
    setDotContent(updated);
  }, [dotContent, selectedNode]);

  // ── Node click handler ──
  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNode((prev) => (prev === nodeId ? null : nodeId));
  }, []);

  return (
    <div className="relative w-full h-full">
      {children}

      {/* Drag hint overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-4 rounded-xl border-2 border-dashed border-blue-500/60 bg-gray-950/80 backdrop-blur-sm" />
          <div className="relative text-center space-y-2">
            <div className="text-2xl">{"\u2B07"}</div>
            <div className="text-base font-medium text-blue-300">Drop .dot file to view</div>
          </div>
        </div>
      )}

      {/* DOT viewer overlay */}
      {dotContent && (
        <div className="fixed inset-0 z-40 flex flex-col bg-gray-950">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 shrink-0 bg-gray-900/50">
            <span className="text-xs font-mono text-gray-400 truncate">{dotFileName}</span>
            <span className="text-xs text-gray-600">DOT preview</span>
            {dirty && <span className="text-[10px] text-amber-500/80">(unsaved)</span>}
            <div className="ml-auto flex items-center gap-2">
              {/* Enable Editing / Save / Download button */}
              {fileHandleRef.current && !editingEnabled && (
                <button
                  onClick={handleEnableEditing}
                  className="text-[11px] text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors border border-blue-800/40"
                >
                  Enable Editing
                </button>
              )}
              {editingEnabled && dirty && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="text-[11px] text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors border border-blue-800/40 disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              )}
              {!fileHandleRef.current && dirty && (
                <button
                  onClick={handleSave}
                  className="text-[11px] text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors border border-blue-800/40"
                >
                  Download
                </button>
              )}
              <button
                onClick={closeOverlay}
                className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                title="Close (Esc)"
              >
                {"\u2715"} Close
              </button>
            </div>
          </div>

          {/* Body: graph + optional detail panel */}
          <div className="flex flex-1 min-h-0">
            {/* Graph */}
            <div className="flex-1 min-w-0">
              <DotPreview
                dot={debouncedDot ?? dotContent}
                className="h-full"
                completedNodes={[]}
                failedNodes={[]}
                selectedNode={selectedNode ?? undefined}
                onNodeClick={handleNodeClick}
                edgeToEdge
              />
            </div>

            {/* Detail panel */}
            {selectedNode && (
              <NodeDetailPanel
                nodeId={selectedNode}
                nodeLabel={nodeLabels.get(selectedNode) ?? selectedNode}
                dot={dotContent}
                onClose={() => setSelectedNode(null)}
                editable={editingEnabled}
                onAttrChange={handleAttrChange}
                onSave={handleSave}
                onRevert={handleRevert}
                saving={saving}
                dirty={dirty}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
