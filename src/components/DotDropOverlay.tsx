import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { DotPreview } from "./DotPreview";

interface DotDropOverlayProps {
  children: ReactNode;
}

export function DotDropOverlay({ children }: DotDropOverlayProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dotContent, setDotContent] = useState<string | null>(null);
  const [dotFileName, setDotFileName] = useState<string>("");
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer?.types.includes("Files")) {
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

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);

    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (!file.name.endsWith(".dot") && !file.name.endsWith(".gv")) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === "string") {
        setDotContent(text);
        setDotFileName(file.name);
      }
    };
    reader.readAsText(file);
  }, []);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDotContent(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative w-full h-full">
      {children}

      {/* Drag hint overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-4 rounded-xl border-2 border-dashed border-blue-500/60 bg-gray-950/80 backdrop-blur-sm" />
          <div className="relative text-center space-y-2">
            <div className="text-2xl">⬇</div>
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
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setDotContent(null)}
                className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                title="Close (Esc)"
              >
                ✕ Close
              </button>
            </div>
          </div>
          {/* Graph */}
          <div className="flex-1 min-h-0">
            <DotPreview
              dot={dotContent}
              className="h-full"
              completedNodes={[]}
              failedNodes={[]}
              edgeToEdge
            />
          </div>
        </div>
      )}
    </div>
  );
}
