/**
 * Parse every node's label attribute from a DOT graph string.
 * Returns a Map<nodeId, label>. Nodes without an explicit label are omitted
 * (the caller should fall back to the node ID itself).
 *
 * Handles:
 *   nodeId [label="Human Readable Name", ...]
 *   nodeId [label=SingleWord, ...]
 * Strips DOT line-break escapes (\n, \l, \r) for clean single-line display.
 */
export function parseAllNodeLabels(dot: string): Map<string, string> {
  const labels = new Map<string, string>();
  if (!dot) return labels;

  // Match node attribute blocks: word\s*[\s*attrs\s*]
  const nodeRe = /\b(\w+)\s*\[([^\]]{0,8000})\]/g;
  let m;
  while ((m = nodeRe.exec(dot)) !== null) {
    const nodeId = m[1];
    // Skip DOT keywords
    if (nodeId === "graph" || nodeId === "digraph" || nodeId === "node" || nodeId === "edge" || nodeId === "subgraph") continue;
    const attrs = m[2];
    // Prefer quoted label, fall back to unquoted
    const labelMatch =
      /\blabel\s*=\s*"([^"]*)"/.exec(attrs) ||
      /\blabel\s*=\s*([^\s,\]]+)/.exec(attrs);
    if (labelMatch) {
      const raw = labelMatch[1];
      // Collapse DOT line-break escapes to spaces
      const clean = raw.replace(/\\[nlr]/g, " ").replace(/\s+/g, " ").trim();
      if (clean) labels.set(nodeId, clean);
    }
  }
  return labels;
}
