export type FileKind =
  | "json"
  | "ndjson"
  | "yaml"
  | "html"
  | "xml"
  | "markdown"
  | "diff"
  | "dot"
  | "pid"
  | "docker-build"
  | "log"
  | "text"
  | "image"
  | "video"
  | "archive"
  | "binary";

export interface FileDescriptor {
  name: string;
  mime?: string;
  kind: FileKind;
  previewable: boolean;
  jsonSubtype?: JsonSubtype;
}

export type JsonSubtype =
  | "stage_status"
  | "run_record"
  | "cli_invocation"
  | "tool_invocation"
  | "timing"
  | "events_array"
  | "parallel_results"
  | "checkpoint"
  | "live_event"
  | "live_status_paths"
  | "live_io_heartbeat"
  | "live_failure"
  | "live_retry"
  | "manifest"
  | "final"
  | "preflight_report"
  | "model_catalog"
  | "run_config"
  | "partial_status"
  | "generic_object"
  | "generic_array"
  | "unknown";

export function fingerprintFile(name: string, mime?: string, textSample = ""): FileDescriptor {
  const n = name.toLowerCase();
  const m = (mime || "").toLowerCase();
  const isMarkdownFile = n.endsWith(".md") || m.includes("markdown");

  if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/.test(n)) {
    return { name, mime, kind: "image", previewable: true };
  }
  if (m.startsWith("video/") || /\.(mp4|webm|mov)$/.test(n)) {
    return { name, mime, kind: "video", previewable: true };
  }
  if (/\.(tgz|gz|zip|tar)$/.test(n)) {
    return { name, mime, kind: "archive", previewable: false };
  }
  if (n.endsWith(".ndjson") || m.includes("ndjson")) {
    return { name, mime, kind: "ndjson", previewable: true };
  }

  // Content sniffing must run before extension-only fallbacks so files like
  // response.md (JSONL transcript) are rendered with the right visualizer.
  if (looksLikeNDJSON(textSample) && (!isMarkdownFile || shouldInterpretMarkdownAsStructuredJson(textSample, n))) {
    return { name, mime, kind: "ndjson", previewable: true };
  }
  if (looksLikeJSONObjectStream(textSample) && (!isMarkdownFile || shouldInterpretMarkdownAsStructuredJson(textSample, n))) {
    return { name, mime, kind: "ndjson", previewable: true };
  }
  if (looksLikeJSON(textSample) && (!isMarkdownFile || shouldInterpretMarkdownAsStructuredJson(textSample, n))) {
    return { name, mime, kind: "json", previewable: true, jsonSubtype: fingerprintJsonContent(textSample, name) };
  }
  if (looksLikeDiff(textSample)) {
    return { name, mime, kind: "diff", previewable: true };
  }
  if (looksLikeDockerBuild(textSample)) {
    return { name, mime, kind: "docker-build", previewable: true };
  }

  if (n.endsWith(".json") || m.includes("json")) {
    return { name, mime, kind: "json", previewable: true, jsonSubtype: fingerprintJsonContent(textSample, name) };
  }
  if (n.endsWith(".yaml") || n.endsWith(".yml") || m.includes("yaml")) {
    return { name, mime, kind: "yaml", previewable: true };
  }
  if (n.endsWith(".html") || n.endsWith(".htm") || m.includes("text/html")) {
    return { name, mime, kind: "html", previewable: true };
  }
  if (n.endsWith(".xml") || m.includes("xml")) {
    return { name, mime, kind: "xml", previewable: true };
  }
  if (n.endsWith(".md") || m.includes("markdown")) {
    return { name, mime, kind: "markdown", previewable: true };
  }
  if (n.endsWith(".patch") || n.endsWith(".diff")) {
    return { name, mime, kind: "diff", previewable: true };
  }
  if (n.endsWith(".dot") || m.includes("graphviz")) {
    return { name, mime, kind: "dot", previewable: true };
  }
  if (n.endsWith(".pid")) {
    return { name, mime, kind: "pid", previewable: true };
  }
  if (n.endsWith(".log")) {
    return { name, mime, kind: "log", previewable: true };
  }

  const likelyText = textSample.length === 0 || !/[\u0000-\u0008\u000E-\u001A]/.test(textSample);
  return { name, mime, kind: likelyText ? "text" : "binary", previewable: likelyText };
}

function looksLikeJSON(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function looksLikeNDJSON(s: string): boolean {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 5);
  if (lines.length < 2) return false;
  try {
    return lines.every((line) => {
      if (!(line.startsWith("{") && line.endsWith("}"))) return false;
      const parsed = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null;
    });
  } catch {
    return false;
  }
}

function looksLikeDiff(s: string): boolean {
  return s.includes("\n@@") || s.startsWith("--- ") || s.startsWith("diff --git ");
}

function looksLikeDockerBuild(s: string): boolean {
  // BuildKit plain-progress format: lines starting with "#N " where N is a number.
  // Require at least 4 such lines to avoid false positives on shell scripts with
  // comments like "# step 1".
  const lines = s.split("\n");
  let count = 0;
  for (const line of lines) {
    if (/^#\d+ /.test(line.trim())) {
      count++;
      if (count >= 4) return true;
    }
  }
  return false;
}

function looksLikeJSONObjectStream(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("{")) return false;
  const objects = extractTopLevelJsonValues(t);
  return objects.length > 1;
}

function shouldInterpretMarkdownAsStructuredJson(text: string, fileName: string): boolean {
  // response.md is frequently an LLM transcript stream in JSON objects.
  if (fileName.endsWith("response.md")) return true;
  // For other markdown files, only treat as structured JSON when strongly indicated.
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const keys = Object.keys(obj);
      return ["type", "role", "message", "content", "session_id"].some((k) => keys.includes(k));
    }
  } catch {
    const stream = extractTopLevelJsonValues(t);
    if (stream.length > 1) return true;
  }
  return false;
}

function extractTopLevelJsonValues(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    const ch = text[i];
    if (ch !== "{" && ch !== "[") break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < n; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "\"") inString = false;
        continue;
      }
      if (c === "\"") {
        inString = true;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          const fragment = text.slice(start, i + 1).trim();
          try {
            JSON.parse(fragment);
            out.push(fragment);
          } catch {
            return out;
          }
          i += 1;
          break;
        }
      }
    }
  }
  return out;
}

export function fingerprintJsonContent(text: string, fileName = ""): JsonSubtype {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        const first = parsed[0] as Record<string, unknown>;
        const keys = new Set(Object.keys(first));
        if (keys.has("type") || keys.has("message") || keys.has("session_id")) return "events_array";
        if (keys.has("branch_key") && keys.has("outcome")) return "parallel_results";
      }
      return "generic_array";
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const keys = new Set(Object.keys(obj));
      if ((keys.has("id") || keys.has("run_id")) && keys.has("dot_file") && keys.has("repo") && keys.has("started_at") && keys.has("status")) {
        return "run_record";
      }
      if (["version", "repo", "cxdb", "llm", "modeldb", "git", "setup", "runtime_policy", "preflight"].every((k) => keys.has(k))) {
        return "run_config";
      }
      if (keys.has("files_changed") && keys.has("harvested") && keys.has("node_id")) return "partial_status";
      if (keys.has("status")) return "stage_status";
      if (keys.has("argv") && keys.has("provider") && keys.has("prompt_bytes")) return "cli_invocation";
      if (keys.has("tool") && keys.has("command") && keys.has("working_dir")) return "tool_invocation";
      if (keys.has("duration_ms") && keys.has("exit_code")) return "timing";
      if (keys.has("timestamp") && keys.has("current_node") && keys.has("completed_nodes")) return "checkpoint";
      if (keys.has("event") && keys.has("from_node") && keys.has("to_node")) return "live_event";
      if (keys.has("event") && keys.has("node_id") && keys.has("run_id") && keys.has("status_fallback_path") && keys.has("status_path")) {
        return "live_status_paths";
      }
      if (keys.has("event") && keys.has("node_id") && keys.has("run_id") && keys.has("elapsed_s") && keys.has("stderr_bytes") && keys.has("stdout_bytes")) {
        return "live_io_heartbeat";
      }
      if (keys.has("event") && keys.has("failure_class") && keys.has("failure_reason") && keys.has("target_node")) {
        return "live_failure";
      }
      if (keys.has("attempt") && keys.has("event") && keys.has("max") && keys.has("node_id") && keys.has("run_id")) {
        return "live_retry";
      }
      if (keys.has("graph_dot") && keys.has("run_id") && keys.has("repo_path")) return "manifest";
      if (keys.has("final_git_commit_sha") && keys.has("run_id")) return "final";
      if (keys.has("checks") && keys.has("summary") && keys.has("generated_at")) return "preflight_report";
      if (keys.has("data") && Array.isArray(obj.data)) return "model_catalog";
      return "generic_object";
    }
    return "unknown";
  } catch {
    if (fileName.toLowerCase().endsWith("run.json")) return "run_record";
    if (fileName.toLowerCase().includes("status")) return "stage_status";
    return "unknown";
  }
}
