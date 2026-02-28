import { useState, useEffect, useRef, useCallback } from "react";
import { instance } from "@viz-js/viz";
import type { RunAnnotation, VisitedStage } from "../lib/types";

interface Props {
  dot: string;
  className?: string;
  highlightNode?: string;
  completedNodes?: string[];
  failedNodes?: string[];
  onNodeClick?: (nodeName: string) => void;
  selectedNode?: string;
  nodeAnnotations?: Record<string, string>;
  reportAnnotationsByNode?: Record<string, RunAnnotation[]>;
  onReportAnnotationClick?: (annotation: RunAnnotation) => void;
  disableInteraction?: boolean;
  edgeToEdge?: boolean;
  stageHistory?: VisitedStage[];
  hoveredHistoryIndex?: number | null;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const ZOOM_STEP = 0.15;
const CLICK_THRESHOLD_PX = 5;

const TRAVERSED_EDGE_COLOR = "#38bdf8"; // sky-400
const GLOW_FILTERS = `
  <filter id="glow-selected" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#60a5fa" flood-opacity="1"/>
  </filter>
  <filter id="glow-active" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#f59e0b" flood-opacity="1"/>
  </filter>
`;

export function DotPreview({
  dot,
  className = "",
  highlightNode,
  completedNodes,
  failedNodes,
  onNodeClick,
  selectedNode,
  nodeAnnotations,
  reportAnnotationsByNode,
  onReportAnnotationClick,
  disableInteraction,
  edgeToEdge,
  stageHistory,
  hoveredHistoryIndex,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [svgVersion, setSvgVersion] = useState(0);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(null);
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const wasDragging = useRef(false);
  const pinchRef = useRef<{ startDist: number; startScale: number; midX: number; midY: number } | null>(null);

  // Reset transform when DOT content changes.
  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [dot]);

  // Render SVG.
  useEffect(() => {
    if (!dot || !containerRef.current) return;
    let cancelled = false;

    instance().then((viz) => {
      if (cancelled) return;
      try {
        const svg = viz.renderSVGElement(dot);
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.transformOrigin = "0 0";

        // Inject glow filter defs.
        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        defs.innerHTML = GLOW_FILTERS;
        svg.insertBefore(defs, svg.firstChild);

        // Dark theme colors.
        svg.querySelectorAll("text").forEach((t) => {
          t.setAttribute("fill", "#d1d5db");
        });
        svg.querySelectorAll("polygon").forEach((p) => {
          const fill = p.getAttribute("fill");
          if (fill === "white" || fill === "#ffffff") {
            p.setAttribute("fill", "transparent");
          }
        });
        svg.querySelectorAll("path, ellipse, polygon, polyline").forEach((el) => {
          const stroke = el.getAttribute("stroke");
          if (stroke === "black" || stroke === "#000000") {
            el.setAttribute("stroke", "#6b7280");
          }
        });
        // Convert black fills inside nodes to transparent (fixes dark bars
        // in diamond/doublecircle/record shapes).
        svg.querySelectorAll("g.node polygon, g.node ellipse, g.node path, g.node polyline").forEach((el) => {
          const fill = el.getAttribute("fill");
          if (fill === "black" || fill === "#000000" || fill === "none") {
            el.setAttribute("fill", "transparent");
          }
        });
        // Convert black arrowhead fills on edges to match stroke color.
        svg.querySelectorAll("g.edge polygon").forEach((el) => {
          const fill = el.getAttribute("fill");
          if (fill === "black" || fill === "#000000") {
            el.setAttribute("fill", "#6b7280");
          }
        });
        // Remove the graph boundary polygon so the preview doesn't look inset
        // inside an extra framed panel.
        const graphBoundary = svg.querySelector("g.graph > polygon, g#graph0 > polygon");
        if (graphBoundary) {
          graphBoundary.setAttribute("fill", "transparent");
          graphBoundary.setAttribute("stroke", "transparent");
        }
        // Give start/exit terminal nodes a softer, theme-aligned treatment.
        svg.querySelectorAll("g.node").forEach((g) => {
          const title = g.querySelector("title")?.textContent?.trim().toLowerCase();
          if (title !== "start" && title !== "exit") return;
          const shapes = Array.from(g.querySelectorAll<SVGElement>("polygon, ellipse, path, polyline"));
          shapes.forEach((shape, idx) => {
            if (idx === 0) {
              shape.setAttribute("stroke", "#94a3b8");
              shape.setAttribute("fill", "rgba(148, 163, 184, 0.10)");
              shape.setAttribute("stroke-width", "1.5");
              return;
            }
            shape.setAttribute("stroke", "transparent");
            shape.setAttribute("fill", "transparent");
          });
          g.querySelectorAll("text").forEach((t) => {
            t.setAttribute("fill", "#cbd5e1");
          });
        });

        if (containerRef.current) {
          containerRef.current.innerHTML = "";
          containerRef.current.appendChild(svg);
          svgRef.current = svg;
          setSvgVersion((v) => v + 1);

          // Add hover, cursor styling, and click handlers to all nodes
          svg.querySelectorAll("g.node").forEach((g) => {
            const node = g as HTMLElement;
            node.style.cursor = "pointer";
            node.addEventListener("mouseenter", () => {
              node.style.opacity = "0.7";
            });
            node.addEventListener("mouseleave", () => {
              node.style.opacity = "1";
            });
            node.addEventListener("click", (ev) => {
              if (wasDragging.current) return;
              const title = g.querySelector("title")?.textContent?.trim();
              if (title && onNodeClick) {
                onNodeClick(title);
              }
              ev.stopPropagation();
            });
          });
        }
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to render graph");
      }
    });

    return () => { cancelled = true; };
  }, [dot]);

  // Apply node highlighting after render or when highlight/completion/failure/selection state changes.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    // Reset all node styles first.
    svg.querySelectorAll("g.node").forEach((g) => {
      g.querySelectorAll("polygon, ellipse, path").forEach((shape) => {
        shape.removeAttribute("data-highlighted");
        shape.removeAttribute("data-completed");
        shape.removeAttribute("data-selected");
        shape.removeAttribute("filter");
        const origStroke = shape.getAttribute("data-orig-stroke");
        const origFill = shape.getAttribute("data-orig-fill");
        if (origStroke !== null) shape.setAttribute("stroke", origStroke);
        if (origFill !== null) shape.setAttribute("fill", origFill);
        shape.setAttribute("stroke-width", "1");
      });
      g.querySelectorAll("text").forEach((t) => {
        const origFill = t.getAttribute("data-orig-text-fill");
        if (origFill !== null) t.setAttribute("fill", origFill);
      });
    });

    const completedSet = new Set(completedNodes || []);
    const failedSet = new Set(failedNodes || []);

    svg.querySelectorAll("g.node").forEach((g) => {
      const title = g.querySelector("title")?.textContent?.trim() || "";
      const isActive = highlightNode != null && title === highlightNode;
      const isSelected = selectedNode != null && title === selectedNode;
      const isCompleted = completedSet.has(title);
      const isFailed = failedSet.has(title);

      if (!isActive && !isSelected && !isFailed && !isCompleted) return;

      g.querySelectorAll("polygon, ellipse, path").forEach((shape) => {
        // Save original values once.
        if (shape.getAttribute("data-orig-stroke") === null) {
          shape.setAttribute("data-orig-stroke", shape.getAttribute("stroke") || "");
          shape.setAttribute("data-orig-fill", shape.getAttribute("fill") || "");
        }

        // Apply status-based fill/stroke (priority: active > failed > completed).
        if (isActive) {
          shape.setAttribute("stroke", "#f59e0b");
          shape.setAttribute("stroke-width", "2");
          shape.setAttribute("fill", "rgba(245, 158, 11, 0.12)");
          shape.setAttribute("data-highlighted", "true");
        } else if (isFailed) {
          shape.setAttribute("stroke", "#ef4444");
          shape.setAttribute("stroke-width", "2");
          shape.setAttribute("fill", "rgba(239, 68, 68, 0.12)");
          shape.setAttribute("data-failed", "true");
        } else if (isCompleted) {
          shape.setAttribute("stroke", "#22c55e");
          shape.setAttribute("stroke-width", "2");
          shape.setAttribute("fill", "rgba(34, 197, 94, 0.10)");
          shape.setAttribute("data-completed", "true");
        }

        // Overlay outer glow for selected or active (additive — preserves status color).
        if (isSelected) {
          shape.setAttribute("filter", "url(#glow-selected)");
          shape.setAttribute("data-selected", "true");
          // Boost stroke-width slightly for selected if not already set by status
          if (!isActive && !isFailed && !isCompleted) {
            shape.setAttribute("stroke", "#6b7280");
            shape.setAttribute("stroke-width", "1.5");
          }
        } else if (isActive) {
          shape.setAttribute("filter", "url(#glow-active)");
        }
      });

      g.querySelectorAll("text").forEach((t) => {
        if (t.getAttribute("data-orig-text-fill") === null) {
          t.setAttribute("data-orig-text-fill", t.getAttribute("fill") || "");
        }
        if (isActive) t.setAttribute("fill", "#fbbf24");
        else if (isFailed) t.setAttribute("fill", "#f87171");
        else if (isCompleted) t.setAttribute("fill", "#4ade80");
      });
    });
  }, [highlightNode, completedNodes, failedNodes, dot, selectedNode, svgVersion]);

  // Highlight traversed edges and add traversal count badges.
  // When hoveredHistoryIndex is set, only highlights edges up to that point;
  // edges traversed after it are dimmed to a lighter gray.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    svg.querySelectorAll(".traversal-badge").forEach((el) => el.remove());

    // Reset edge styles.
    svg.querySelectorAll("g.edge").forEach((edgeG) => {
      edgeG.querySelectorAll("path, polyline").forEach((el) => {
        const origStroke = el.getAttribute("data-edge-orig-stroke");
        const origWidth = el.getAttribute("data-edge-orig-width");
        if (origStroke !== null) { el.setAttribute("stroke", origStroke); el.removeAttribute("data-edge-orig-stroke"); }
        if (origWidth !== null) { el.setAttribute("stroke-width", origWidth); el.removeAttribute("data-edge-orig-width"); }
      });
      edgeG.querySelectorAll("polygon").forEach((el) => {
        const origFill = el.getAttribute("data-edge-orig-fill");
        const origStroke = el.getAttribute("data-edge-orig-stroke");
        if (origFill !== null) { el.setAttribute("fill", origFill); el.removeAttribute("data-edge-orig-fill"); }
        if (origStroke !== null) { el.setAttribute("stroke", origStroke); el.removeAttribute("data-edge-orig-stroke"); }
      });
    });

    if (!stageHistory?.length) return;

    // Only use main-run stages for edge computation (skip branch children)
    const mainHistory = stageHistory.filter((v) => !v.fan_out_node);

    const isHovering = hoveredHistoryIndex != null;
    // hoveredHistoryIndex is an index into the full stageHistory (may include branch children).
    // Map it to an index in mainHistory by finding the hovered visit's node_id position.
    let previewEnd = mainHistory.length - 1;
    if (isHovering) {
      const hoveredVisit = stageHistory[hoveredHistoryIndex!];
      if (hoveredVisit) {
        // Find the last mainHistory entry at or before this full-history index
        const fullIdx = hoveredHistoryIndex!;
        let mapped = -1;
        let mainIdx = 0;
        for (let fi = 0; fi <= fullIdx && mainIdx < mainHistory.length; fi++) {
          if (!stageHistory[fi]?.fan_out_node) {
            if (fi <= fullIdx) mapped = mainIdx;
            mainIdx++;
          }
        }
        previewEnd = mapped >= 0 ? mapped : mainHistory.length - 1;
      }
      previewEnd = Math.min(previewEnd, mainHistory.length - 1);
    }

    const previewTraversals = new Map<string, number>();
    for (let i = 0; i < previewEnd; i++) {
      const a = mainHistory[i];
      const b = mainHistory[i + 1];
      if (a && b) previewTraversals.set(`${a.node_id}->${b.node_id}`, (previewTraversals.get(`${a.node_id}->${b.node_id}`) ?? 0) + 1);
    }

    // Future traversals: pairs after the hovered step that aren't already in preview
    const futureTraversals = new Set<string>();
    if (isHovering) {
      for (let i = previewEnd; i < mainHistory.length - 1; i++) {
        const a = mainHistory[i];
        const b = mainHistory[i + 1];
        if (!a || !b) continue;
        const key = `${a.node_id}->${b.node_id}`;
        if (!previewTraversals.has(key)) futureTraversals.add(key);
      }
    }

    if (previewTraversals.size === 0 && futureTraversals.size === 0) return;

    const FUTURE_EDGE_COLOR = "#4b5563"; // dim gray for future edges
    const ns = "http://www.w3.org/2000/svg";
    const graphGroup = svg.querySelector("g#graph0") || svg.querySelector("g");
    if (!graphGroup) return;

    svg.querySelectorAll("g.edge").forEach((edgeG) => {
      const titleText = edgeG.querySelector("title")?.textContent?.trim() || "";
      const normalized = titleText.replace(/\s*->\s*/g, "->");

      const count = previewTraversals.get(normalized) ?? 0;
      const isFuture = futureTraversals.has(normalized);

      if (!count && !isFuture) return;

      const color = isFuture ? FUTURE_EDGE_COLOR : TRAVERSED_EDGE_COLOR;
      const strokeWidth = count > 1 ? 1 + (count - 1) * 0.5 : 1;

      edgeG.querySelectorAll("path, polyline").forEach((el) => {
        if (el.getAttribute("data-edge-orig-stroke") === null) {
          el.setAttribute("data-edge-orig-stroke", el.getAttribute("stroke") || "");
          el.setAttribute("data-edge-orig-width", el.getAttribute("stroke-width") || "1");
        }
        el.setAttribute("stroke", color);
        el.setAttribute("stroke-width", String(strokeWidth));
      });
      edgeG.querySelectorAll("polygon").forEach((el) => {
        if (el.getAttribute("data-edge-orig-fill") === null) {
          el.setAttribute("data-edge-orig-fill", el.getAttribute("fill") || "");
          el.setAttribute("data-edge-orig-stroke", el.getAttribute("stroke") || "");
        }
        el.setAttribute("fill", color);
        el.setAttribute("stroke", color);
      });

      // Count badge for edges traversed more than once (only for highlighted, not future)
      if (count > 1) {
        const path = edgeG.querySelector("path");
        if (!path) return;
        const totalLen = path.getTotalLength();
        const mid = path.getPointAtLength(totalLen * 0.5);

        const group = document.createElementNS(ns, "g");
        group.setAttribute("class", "traversal-badge");

        const circle = document.createElementNS(ns, "circle");
        circle.setAttribute("cx", String(mid.x));
        circle.setAttribute("cy", String(mid.y));
        circle.setAttribute("r", "8");
        circle.setAttribute("fill", "#0c1a2e");
        circle.setAttribute("stroke", TRAVERSED_EDGE_COLOR);
        circle.setAttribute("stroke-width", "1.5");
        group.appendChild(circle);

        const text = document.createElementNS(ns, "text");
        text.setAttribute("x", String(mid.x));
        text.setAttribute("y", String(mid.y));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "central");
        text.setAttribute("font-family", "monospace");
        text.setAttribute("font-size", "9");
        text.setAttribute("font-weight", "700");
        text.setAttribute("fill", TRAVERSED_EDGE_COLOR);
        text.textContent = String(count);
        group.appendChild(text);

        graphGroup.appendChild(group);
      }
    });
  }, [stageHistory, hoveredHistoryIndex, svgVersion]);

  // Add per-node visit count badges (shown when a node is visited more than once).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    svg.querySelectorAll(".visit-badge").forEach((el) => el.remove());

    if (!stageHistory?.length) return;

    // Tally pass and fail counts per node (ignore currently-running entries).
    const nodeCounts = new Map<string, { pass: number; fail: number }>();
    for (const visit of stageHistory) {
      if (visit.status === "running") continue;
      const entry = nodeCounts.get(visit.node_id) ?? { pass: 0, fail: 0 };
      if (visit.status === "pass") entry.pass++;
      else if (visit.status === "fail") entry.fail++;
      nodeCounts.set(visit.node_id, entry);
    }

    const ns = "http://www.w3.org/2000/svg";
    const graphGroup = svg.querySelector("g#graph0") || svg.querySelector("g");
    if (!graphGroup) return;

    svg.querySelectorAll("g.node").forEach((nodeG) => {
      const title = nodeG.querySelector("title")?.textContent?.trim() || "";
      const counts = nodeCounts.get(title);
      if (!counts) return;
      const total = counts.pass + counts.fail;
      if (total <= 1) return;

      const bbox = (nodeG as SVGGraphicsElement).getBBox();
      const topRightX = bbox.x + bbox.width;
      const topRightY = bbox.y;

      const badges: Array<{ count: number; bgColor: string; strokeColor: string; textColor: string }> = [];
      if (counts.pass > 0) badges.push({ count: counts.pass, bgColor: "#052e16", strokeColor: "#4ade80", textColor: "#4ade80" });
      if (counts.fail > 0) badges.push({ count: counts.fail, bgColor: "#450a0a", strokeColor: "#f87171", textColor: "#f87171" });

      badges.forEach((badge, idx) => {
        // Center the first badge exactly on the top-right corner of the node box
        const cx = topRightX + idx * 16;
        const cy = topRightY;

        const group = document.createElementNS(ns, "g");
        group.setAttribute("class", "visit-badge");

        const circle = document.createElementNS(ns, "circle");
        circle.setAttribute("cx", String(cx));
        circle.setAttribute("cy", String(cy));
        circle.setAttribute("r", "8");
        circle.setAttribute("fill", badge.bgColor);
        circle.setAttribute("stroke", badge.strokeColor);
        circle.setAttribute("stroke-width", "1.5");
        group.appendChild(circle);

        const text = document.createElementNS(ns, "text");
        text.setAttribute("x", String(cx));
        text.setAttribute("y", String(cy));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "central");
        text.setAttribute("font-family", "monospace");
        text.setAttribute("font-size", "8");
        text.setAttribute("font-weight", "700");
        text.setAttribute("fill", badge.textColor);
        text.textContent = String(badge.count);
        group.appendChild(text);

        graphGroup.appendChild(group);
      });
    });
  }, [stageHistory, svgVersion]);

  // Render feedback response annotations as bubbles on outgoing edges.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !nodeAnnotations) return;

    svg.querySelectorAll(".feedback-annotation").forEach((el) => el.remove());

    const entries = Object.entries(nodeAnnotations);
    if (entries.length === 0) return;

    const ns = "http://www.w3.org/2000/svg";

    const graphGroup = svg.querySelector("g#graph0") || svg.querySelector("g");
    if (!graphGroup) return;

    const edges = svg.querySelectorAll("g.edge");

    for (const [nodeId, annotation] of entries) {
      let edgePath: SVGPathElement | null = null;
      for (const edge of edges) {
        const titleEl = edge.querySelector("title");
        if (!titleEl) continue;
        const titleText = titleEl.textContent?.trim() || "";
        const arrowIdx = titleText.indexOf("->");
        if (arrowIdx === -1) continue;
        const source = titleText.slice(0, arrowIdx).trim();
        if (source === nodeId) {
          edgePath = edge.querySelector("path");
          break;
        }
      }
      if (!edgePath) continue;

      const totalLen = edgePath.getTotalLength();
      const mid = edgePath.getPointAtLength(totalLen * 0.4);

      const maxLen = 24;
      const displayText = annotation.length > maxLen
        ? annotation.slice(0, maxLen) + "…"
        : annotation;

      const group = document.createElementNS(ns, "g");
      group.setAttribute("class", "feedback-annotation");

      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", String(mid.x));
      text.setAttribute("y", String(mid.y));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.setAttribute("font-family", "monospace");
      text.setAttribute("font-size", "10");
      text.setAttribute("fill", "#fbbf24");
      text.textContent = displayText;
      group.appendChild(text);

      graphGroup.appendChild(group);
      const bbox = text.getBBox();

      const padX = 6;
      const padY = 3;
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", String(bbox.x - padX));
      rect.setAttribute("y", String(bbox.y - padY));
      rect.setAttribute("width", String(bbox.width + padX * 2));
      rect.setAttribute("height", String(bbox.height + padY * 2));
      rect.setAttribute("rx", "4");
      rect.setAttribute("ry", "4");
      rect.setAttribute("fill", "rgba(30, 30, 30, 0.92)");
      rect.setAttribute("stroke", "#f59e0b");
      rect.setAttribute("stroke-width", "1");

      group.insertBefore(rect, text);
    }
  }, [nodeAnnotations, dot, svgVersion]);

  // Render report/review badges directly on nodes.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll(".report-annotation").forEach((el) => el.remove());
    if (!reportAnnotationsByNode) return;

    const ns = "http://www.w3.org/2000/svg";
    const graphGroup = svg.querySelector("g#graph0") || svg.querySelector("g");
    if (!graphGroup) return;
    const edges = svg.querySelectorAll("g.edge");

    Object.entries(reportAnnotationsByNode).forEach(([nodeName, annotations]) => {
      if (annotations.length === 0) return;

      let edgePath: SVGPathElement | null = null;
      for (const edge of edges) {
        const titleEl = edge.querySelector("title");
        if (!titleEl) continue;
        const titleText = titleEl.textContent?.trim() || "";
        const arrowIdx = titleText.indexOf("->");
        if (arrowIdx === -1) continue;
        const source = titleText.slice(0, arrowIdx).trim();
        if (source === nodeName) {
          edgePath = edge.querySelector("path");
          break;
        }
      }
      if (!edgePath) return;

      const totalLen = edgePath.getTotalLength();
      const anchor = edgePath.getPointAtLength(totalLen * 0.5);

      const edgeHit = document.createElementNS(ns, "path");
      edgeHit.setAttribute("class", "report-annotation");
      edgeHit.setAttribute("d", edgePath.getAttribute("d") || "");
      edgeHit.setAttribute("fill", "none");
      edgeHit.setAttribute("stroke", "transparent");
      edgeHit.setAttribute("stroke-width", "16");
      edgeHit.style.cursor = "pointer";
      edgeHit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onNodeClick?.(nodeName);
      });
      graphGroup.appendChild(edgeHit);

      annotations.forEach((marker, idx) => {
        const x = anchor.x;
        const y = anchor.y - (idx * 18);

        const group = document.createElementNS(ns, "g");
        group.setAttribute("class", "report-annotation");
        group.style.cursor = "pointer";

        const circle = document.createElementNS(ns, "circle");
        circle.setAttribute("cx", String(x));
        circle.setAttribute("cy", String(y));
        circle.setAttribute("r", "8");
        circle.setAttribute("fill", marker.kind === "review" ? "#a855f7" : "#0ea5e9");
        circle.setAttribute("stroke", "#111827");
        circle.setAttribute("stroke-width", "1.5");
        group.appendChild(circle);

        const label = document.createElementNS(ns, "text");
        label.setAttribute("x", String(x));
        label.setAttribute("y", String(y + 0.5));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "central");
        label.setAttribute("font-family", "monospace");
        label.setAttribute("font-size", "9");
        label.setAttribute("font-weight", "700");
        label.setAttribute("fill", "#f9fafb");
        label.textContent = marker.kind === "review" ? "V" : "R";
        group.appendChild(label);

        const title = document.createElementNS(ns, "title");
        title.textContent = marker.title;
        group.appendChild(title);

        group.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onReportAnnotationClick?.(marker);
        });
        graphGroup.appendChild(group);
      });
    });
  }, [reportAnnotationsByNode, onReportAnnotationClick, onNodeClick, dot, svgVersion]);

  // Apply transform to SVG.
  useEffect(() => {
    if (svgRef.current) {
      svgRef.current.style.transform = `translate(${translate.x}px, ${translate.y}px) scale(${scale})`;
    }
  }, [scale, translate]);

  // Zoom toward a point in container-local coordinates using a continuous factor.
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setScale((prev) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * factor));
      const ratio = next / prev;
      setTranslate((t) => ({
        x: cx - ratio * (cx - t.x),
        y: cy - ratio * (cy - t.y),
      }));
      return next;
    });
  }, []);

  useEffect(() => {
    if (disableInteraction) return;
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      // Normalize delta across wheel modes
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 15;   // line mode → pixels
      if (e.deltaMode === 2) delta *= 300;  // page mode → pixels

      // macOS pinch-to-zoom fires wheel events with ctrlKey=true and small deltas.
      // Regular scroll uses larger deltas. Use exponential zoom for both so small
      // movements produce small zoom changes (no jumpy step sizes).
      const sensitivity = e.ctrlKey ? 150 : 700;
      zoomAt(Math.exp(-delta / sensitivity), cx, cy);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomAt, disableInteraction]);

  const zoomIn = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    zoomAt(1 + ZOOM_STEP, c.clientWidth / 2, c.clientHeight / 2);
  }, [zoomAt]);

  const zoomOut = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    zoomAt(1 / (1 + ZOOM_STEP), c.clientWidth / 2, c.clientHeight / 2);
  }, [zoomAt]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (disableInteraction) return;
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: translate.x,
      startTy: translate.y,
    };
    pointerDownPos.current = {
      x: e.clientX,
      y: e.clientY,
    };
  }, [translate]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setTranslate({
      x: dragRef.current.startTx + (e.clientX - dragRef.current.startX),
      y: dragRef.current.startTy + (e.clientY - dragRef.current.startY),
    });
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (pointerDownPos.current) {
      const dx = e.clientX - pointerDownPos.current.x;
      const dy = e.clientY - pointerDownPos.current.y;
      wasDragging.current = Math.sqrt(dx * dx + dy * dy) >= CLICK_THRESHOLD_PX;
    } else {
      wasDragging.current = false;
    }

    dragRef.current = null;
    pointerDownPos.current = null;
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disableInteraction) return;
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      pinchRef.current = {
        startDist: dist,
        startScale: scale,
        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
        midY: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
      };
    }
  }, [scale]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (disableInteraction) return;
    if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ratio = dist / pinchRef.current.startDist;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchRef.current.startScale * ratio));
      const scaleRatio = newScale / scale;
      const { midX, midY } = pinchRef.current;
      setScale(newScale);
      setTranslate((t) => ({
        x: midX - scaleRatio * (midX - t.x),
        y: midY - scaleRatio * (midY - t.y),
      }));
    }
  }, [scale]);

  const handleTouchEnd = useCallback(() => {
    pinchRef.current = null;
  }, []);

  if (error) {
    return (
      <div className={`text-sm text-red-400 p-3 bg-gray-800 rounded ${className}`}>
        Graph render error: {error}
      </div>
    );
  }

  const pct = Math.round(scale * 100);

  return (
    <div className={`relative ${className}`}>
      <div
        ref={containerRef}
        data-graph-container
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`${edgeToEdge ? "bg-gray-950 border-0 rounded-none" : "bg-gray-800/50 rounded border border-gray-700"} overflow-hidden h-full select-none ${
          disableInteraction ? "touch-auto" : "cursor-grab active:cursor-grabbing touch-none"
        }`}
      />
      {!disableInteraction && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1 text-xs text-gray-400 bg-gray-900/80 rounded px-2 py-1 border border-gray-700">
          <button onClick={zoomOut} className="px-1 hover:text-gray-200">&minus;</button>
          <button onClick={resetView} className="px-1 hover:text-gray-200 tabular-nums min-w-[3ch] text-center">{pct}%</button>
          <button onClick={zoomIn} className="px-1 hover:text-gray-200">+</button>
        </div>
      )}
    </div>
  );
}
