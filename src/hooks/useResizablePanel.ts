import { useState, useCallback, useRef, useEffect } from "react";

export type ResizeEdge = "left" | "right";

interface UseResizablePanelOpts {
  /** Which edge the resize handle sits on. */
  edge: ResizeEdge;
  /** Initial width in pixels. */
  initialWidth: number;
  /** Minimum width in pixels. */
  minWidth?: number;
  /** Maximum width in pixels. */
  maxWidth?: number;
  /** localStorage key to persist width across sessions. */
  storageKey?: string;
}

export function useResizablePanel({
  edge,
  initialWidth,
  minWidth = 160,
  maxWidth = 800,
  storageKey,
}: UseResizablePanelOpts) {
  const [width, setWidth] = useState<number>(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const n = parseInt(stored, 10);
        if (!isNaN(n) && n >= minWidth && n <= maxWidth) return n;
      }
    }
    return initialWidth;
  });

  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - startX.current;
      // Left-side panel: dragging right = wider. Right-side panel: dragging left = wider.
      const newWidth = edge === "right"
        ? startWidth.current + dx
        : startWidth.current - dx;
      setWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [edge, minWidth, maxWidth]);

  // Persist to localStorage on change
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(width));
    }
  }, [width, storageKey]);

  return { width, onMouseDown };
}

/** Tailwind class string for the drag handle bar. Uses full literal strings so Tailwind can detect them. */
export function resizeHandleClass(edge: ResizeEdge): string {
  if (edge === "left") {
    return "absolute top-0 -left-[3px] w-[6px] h-full cursor-col-resize z-10 hover:bg-blue-500/30 active:bg-blue-500/40 transition-colors";
  }
  return "absolute top-0 -right-[3px] w-[6px] h-full cursor-col-resize z-10 hover:bg-blue-500/30 active:bg-blue-500/40 transition-colors";
}
