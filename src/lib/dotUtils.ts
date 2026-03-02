/**
 * Structured attributes for a single DOT node.
 */
export interface NodeAttrs {
  label?: string;
  shape?: string;
  prompt?: string;
  systemPrompt?: string;
  toolCommand?: string;
  contextFilter?: string;
  maxRetry?: string;
}

/**
 * Extract known attributes for a single named node from a DOT graph string.
 */
export function parseNodeAttrs(dot: string, nodeId: string): NodeAttrs {
  if (!dot || !nodeId) return {};

  // Find this specific node's attribute block: nodeId [...]
  // We allow up to 20000 chars inside the bracket to accommodate long prompts.
  const nodeRe = new RegExp(`\\b${nodeId}\\s*\\[([^\\]]{0,20000})\\]`);
  const m = nodeRe.exec(dot);
  if (!m) return {};
  const block = m[1];

  function extractAttr(name: string): string | undefined {
    // Quoted value (handles \" and \\ inside)
    const qRe = new RegExp(`\\b${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s");
    const qm = qRe.exec(block);
    if (qm) {
      return qm[1]
        .replace(/\\n/g, "\n")
        .replace(/\\l/g, "\n")
        .replace(/\\r/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    // Unquoted value
    const uRe = new RegExp(`\\b${name}\\s*=\\s*([^\\s,\\]]+)`);
    const um = uRe.exec(block);
    return um?.[1];
  }

  const label = extractAttr("label");

  return {
    label: label?.replace(/\\[nlr]/g, " ").replace(/\s+/g, " ").trim(),
    shape: extractAttr("shape"),
    prompt: extractAttr("prompt"),
    systemPrompt: extractAttr("system_prompt"),
    toolCommand: extractAttr("tool_command"),
    contextFilter: extractAttr("context_filter"),
    maxRetry: extractAttr("max_retry"),
  };
}

/**
 * Escape a string value for use inside a DOT double-quoted attribute.
 */
export function dotEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Update (or insert) a single attribute on a named node in a DOT string.
 * Returns the modified DOT string. Preserves file structure as much as possible.
 */
export function updateNodeAttr(dot: string, nodeId: string, attrName: string, newValue: string): string {
  // Find the node's attribute block:  nodeId [....]
  const nodeRe = new RegExp(`(\\b${nodeId}\\s*\\[)([^\\]]{0,20000})(\\])`, "s");
  const nodeMatch = nodeRe.exec(dot);
  if (!nodeMatch) return dot;

  const prefix = nodeMatch[1]; // "nodeId ["
  let block = nodeMatch[2];     // everything inside [...]
  const suffix = nodeMatch[3];  // "]"

  const escaped = dotEscape(newValue);

  // Try to find and replace an existing quoted attribute
  const qRe = new RegExp(`(\\b${attrName}\\s*=\\s*")(?:[^"\\\\]|\\\\.)*(")`,"s");
  if (qRe.test(block)) {
    block = block.replace(qRe, `$1${escaped}$2`);
  } else {
    // Try unquoted
    const uRe = new RegExp(`(\\b${attrName}\\s*=\\s*)([^\\s,\\]]+)`);
    if (uRe.test(block)) {
      block = block.replace(uRe, `$1"${escaped}"`);
    } else {
      // Attribute doesn't exist — insert before closing ]
      const sep = block.trimEnd().endsWith(",") || block.trim() === "" ? " " : ", ";
      block = block.trimEnd() + `${sep}${attrName}="${escaped}"`;
    }
  }

  const start = nodeMatch.index;
  const end = start + nodeMatch[0].length;
  return dot.slice(0, start) + prefix + block + suffix + dot.slice(end);
}

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
