const RUN_PANE_MARKER = "/run-pane/";

function detectRunPaneBase(pathname?: string): string {
  const path = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const idx = path.indexOf(RUN_PANE_MARKER);
  if (idx === -1) return "";
  return path.slice(0, idx + RUN_PANE_MARKER.length - 1);
}

export function routerBasename(): string | undefined {
  const base = detectRunPaneBase();
  return base || undefined;
}

export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = detectRunPaneBase();
  return base ? `${base}${normalized}` : normalized;
}

export function appUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = detectRunPaneBase();
  return base ? `${base}${normalized}` : normalized;
}
