import { useMemo, useState } from "react";
import { fingerprintFile, fingerprintJsonContent, type JsonSubtype } from "../lib/fileFingerprint";
import MarkdownContent from "./MarkdownContent";

import { DotPreview } from "./DotPreview";

function formatTs(raw: unknown): string {
  const s = String(raw || "");
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

interface FileVisualizerProps {
  fileName: string;
  mime?: string;
  content?: string;
  fileUrl?: string;
}

export function FileVisualizer({ fileName, mime, content = "", fileUrl }: FileVisualizerProps) {
  const fp = fingerprintFile(fileName, mime, content.slice(0, 4096));

  if (fp.kind === "image" && fileUrl) {
    return (
      <div className="p-2">
        <img src={fileUrl} alt={fileName} className="max-h-[60vh] sm:max-h-[420px] max-w-full rounded border border-gray-800" />
      </div>
    );
  }
  if (fp.kind === "video" && fileUrl) {
    return (
      <div className="p-2">
        <video controls className="max-h-[60vh] sm:max-h-[420px] max-w-full rounded border border-gray-800">
          <source src={fileUrl} type={mime || "video/mp4"} />
        </video>
      </div>
    );
  }
  if (fp.kind === "archive" || fp.kind === "binary") {
    return <BinaryBlock fileName={fileName} fileUrl={fileUrl} mime={mime} />;
  }
  if (fp.kind === "json") {
    return <JsonBlock text={content} />;
  }
  if (fp.kind === "ndjson") {
    return <NdjsonBlock text={content} />;
  }
  if (fp.kind === "yaml") {
    return <YamlBlock text={content} />;
  }
  if (fp.kind === "html") {
    return <HtmlBlock text={content} />;
  }
  if (fp.kind === "xml") {
    return <XmlBlock text={content} />;
  }
  if (fp.kind === "diff") {
    return <DiffBlock text={content} />;
  }
  if (fp.kind === "dot") {
    return <DotBlock text={content} />;
  }
  if (fp.kind === "pid") {
    return <PidBlock text={content} />;
  }
  if (fp.kind === "markdown") {
    return <MarkdownBlock text={content} />;
  }
  if (fp.kind === "docker-build") {
    return <DockerBuildBlock text={content} />;
  }
  if (fp.kind === "log" || fp.kind === "text") {
    return <TextBlock text={content} />;
  }
  return <PreBlock>{content}</PreBlock>;
}

function prettyJSON(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function renderNDJSON(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const out: string[] = [];
  lines.forEach((line, idx) => {
    try {
      const obj = JSON.parse(line);
      const event = obj.event || obj.type || "event";
      out.push(`[${idx + 1}] ${event}`);
      out.push(JSON.stringify(obj, null, 2));
    } catch {
      out.push(`[${idx + 1}] ${line}`);
    }
    out.push("");
  });
  return out.join("\n").trim();
}

function parseNDJSONObjects(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed lines and let fallback renderer handle context.
    }
  }
  if (rows.length > 0) return rows;
  return parseJsonObjectStream(text);
}

function parseJsonObjectStream(text: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    if (text[i] !== "{" && text[i] !== "[") break;
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
          const chunk = text.slice(start, i + 1).trim();
          try {
            const parsed = JSON.parse(chunk);
            if (parsed && typeof parsed === "object") {
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (item && typeof item === "object") records.push(item as Record<string, unknown>);
                }
              } else {
                records.push(parsed as Record<string, unknown>);
              }
            }
          } catch {
            // stop parsing this stream chunk
          }
          i += 1;
          break;
        }
      }
    }
  }
  return records;
}

function NdjsonBlock({ text }: { text: string }) {
  const records = parseNDJSONObjects(text);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  if (records.length === 0) {
    return <PreBlock>{text}</PreBlock>;
  }

  const looksLikeLLMTranscript = records.some((r) => typeof r.type === "string" || typeof r.message === "object");
  if (!looksLikeLLMTranscript) {
    const parsed = renderNDJSON(text);
    return <PreBlock>{parsed}</PreBlock>;
  }
  const kinds = Array.from(
    new Set(
      records.map((r) => String(r.role || r.type || "event"))
    )
  ).sort();
  const needle = query.trim().toLowerCase();
  const filtered = records.filter((record) => {
    const role = String(record.role || record.type || "event");
    if (filter !== "all" && role !== filter) return false;
    if (!needle) return true;
    const hay = `${role} ${String(record.subtype || "")} ${summarizeTranscriptRecord(record)}`.toLowerCase();
    return hay.includes(needle);
  });

  return (
    <div className="space-y-2 p-2 bg-gray-950 rounded max-h-[60vh] sm:max-h-[520px] overflow-auto">
      <div className="flex flex-wrap items-center gap-2 p-1">
        <select
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          className="flex-1 min-w-0 sm:min-w-[180px] bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300"
          placeholder="Search summaries..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Hide raw JSON" : "Show raw JSON"}
        </button>
      </div>
      <div className="text-[11px] text-gray-500 px-1">
        {filtered.length} events shown (of {records.length})
      </div>
      {filtered.map((record, i) => {
        const role = String(record.role || record.type || "event");
        const subtype = record.subtype ? String(record.subtype) : "";
        const title = subtype ? `${role}:${subtype}` : role;
        const summary = summarizeTranscriptRecord(record);
        const toolDetails = summarizeToolBlocks(record);
        return (
          <div key={i} className="border border-gray-800 rounded bg-gray-900/50 p-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-wide bg-gray-800 text-gray-200 px-2 py-0.5 rounded">
                {title}
              </span>
              {typeof record.session_id === "string" && (
                <span className="text-[10px] text-gray-500 font-mono truncate">
                  {record.session_id}
                </span>
              )}
            </div>
            {summary ? (
              <div className="text-xs text-gray-200 whitespace-pre-wrap mb-2">{summary}</div>
            ) : null}
            <RecordStructuredView record={record} />
            {toolDetails.length > 0 ? (
              <div className="space-y-1 mb-2">
                {toolDetails.map((detail, idx) => (
                  <div key={idx} className="text-[11px] text-gray-200 font-mono break-all border border-gray-800 rounded p-2 bg-gray-950/60">
                    {detail.kind === "tool_use" ? (
                      <>
                        <div className="text-purple-300 mb-1">tool_use: {detail.name || "tool"}</div>
                        <ShellCommandBlock commandText={toolDetailCommand(detail)} />
                      </>
                    ) : (
                      <>
                        <div className="text-sky-300 mb-1">tool_result</div>
                        <pre className="whitespace-pre-wrap text-[11px] text-gray-300">{detail.content}</pre>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            {showRaw ? (
              <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap overflow-auto">
                {JSON.stringify(record, null, 2)}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function summarizeTranscriptRecord(record: Record<string, unknown>): string {
  const message = record.message;
  if (typeof message === "object" && message !== null) {
    const msg = message as Record<string, unknown>;
    const content = msg.content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((part) => typeof part === "object" && part !== null)
        .map((part) => (part as Record<string, unknown>).text)
        .filter((x): x is string => typeof x === "string");
      if (textParts.length > 0) {
        return textParts.join("\n").trim();
      }
    }
  }
  if (typeof record.text === "string") return record.text;
  if (typeof record.event === "string") return record.event;
  return "";
}

type ToolDetail = {
  kind: "tool_use" | "tool_result";
  name?: string;
  content: string;
};

function toolDetailCommand(detail: ToolDetail): string {
  if (detail.kind !== "tool_use") return detail.content;
  try {
    const parsed = JSON.parse(detail.content);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.command === "string" && obj.command.trim()) return obj.command;
      if (Array.isArray(obj.argv)) return obj.argv.map(String).join(" ");
    }
  } catch {
    // fall through
  }
  return detail.content;
}

function summarizeToolBlocks(record: Record<string, unknown>): ToolDetail[] {
  const lines: ToolDetail[] = [];
  const blocks: Array<Record<string, unknown>> = [];
  const directContent = record.content;
  if (Array.isArray(directContent)) {
    for (const b of directContent) {
      if (b && typeof b === "object") blocks.push(b as Record<string, unknown>);
    }
  }
  const message = record.message;
  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && typeof b === "object") blocks.push(b as Record<string, unknown>);
      }
    }
  }
  for (const block of blocks) {
    const type = String(block.type || "");
    if (type === "tool_use") {
      const name = String(block.name || "tool");
      const input = block.input ? JSON.stringify(block.input) : "";
      lines.push({
        kind: "tool_use",
        name,
        content: input,
      });
    } else if (type === "tool_result") {
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
      lines.push({
        kind: "tool_result",
        content: content.slice(0, 2000),
      });
    }
  }
  return lines;
}

function RecordStructuredView({ record }: { record: Record<string, unknown> }) {
  const message = record.message;
  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    return (
      <div className="mb-2 border border-gray-800 rounded bg-gray-950/40 p-2 space-y-1 text-[11px]">
        <div className="text-gray-400">
          fingerprint: <span className="text-gray-200">assistant_message</span>
        </div>
        <div className="text-gray-500">
          role={String(msg.role || "assistant")} model={String(msg.model || "unknown")}
        </div>
        {Array.isArray(msg.content) ? (
          <div className="space-y-1">
            {msg.content.map((c, idx) => (
              <MessageContentBlock key={idx} block={c} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  const scalarRows = Object.entries(record)
    .filter(([, v]) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 8);
  if (scalarRows.length === 0) return null;
  return (
    <div className="mb-2 border border-gray-800 rounded bg-gray-950/40 p-2 space-y-1 text-[11px]">
      <div className="text-gray-400">fingerprint: <span className="text-gray-200">{String(record.type || "record")}</span></div>
      {scalarRows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="text-gray-500 font-mono min-w-[60px] sm:min-w-[90px]">{k}</span>
          <span className="text-gray-300 whitespace-pre-wrap">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function MessageContentBlock({ block }: { block: unknown }) {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const type = String(b.type || "block");
  if (type === "text") {
    const text = String(b.text || "");
    return (
      <div className="border border-gray-800 rounded p-2 bg-gray-950/60">
        <div className="text-emerald-300 mb-1">content:text</div>
        <div className="text-gray-200 whitespace-pre-wrap">{text}</div>
      </div>
    );
  }
  if (type === "tool_use") {
    const name = String(b.name || "tool");
    const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
    const cmd = typeof input.command === "string" ? input.command : Array.isArray(input.argv) ? input.argv.map(String).join(" ") : JSON.stringify(input);
    return (
      <div className="border border-gray-800 rounded p-2 bg-gray-950/60">
        <div className="text-purple-300 mb-1">content:tool_use ({name})</div>
        <ShellCommandBlock commandText={cmd} />
      </div>
    );
  }
  if (type === "tool_result") {
    const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
    return (
      <div className="border border-gray-800 rounded p-2 bg-gray-950/60">
        <div className="text-sky-300 mb-1">content:tool_result</div>
        <pre className="text-[11px] text-gray-300 whitespace-pre-wrap">{content.slice(0, 2000)}</pre>
      </div>
    );
  }
  return (
    <div className="border border-gray-800 rounded p-2 bg-gray-950/60">
      <div className="text-gray-400 mb-1">content:{type}</div>
      <pre className="text-[11px] text-gray-300 whitespace-pre-wrap">{JSON.stringify(b, null, 2)}</pre>
    </div>
  );
}

function JsonBlock({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const pretty = prettyJSON(text);
  const subtype = fingerprintJsonContent(text);
  let summary = "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
    if (Array.isArray(parsed)) summary = `Array (${parsed.length} items)`;
    else if (parsed && typeof parsed === "object") summary = `Object (${Object.keys(parsed).length} keys)`;
  } catch {
    // keep fallback summary empty
  }
  const subtypeLabel = formatSubtype(subtype);
  return (
    <div className="flex flex-col min-h-0">
      <div className="text-xs text-gray-500 px-1 pb-1 flex items-center justify-between gap-2">
        <span>{summary ? `${summary} | ` : ""}Fingerprint: {subtypeLabel}</span>
        <button
          className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Hide raw" : "Show raw"}
        </button>
      </div>
      {renderJsonSubtype(subtype, parsed)}
      {showRaw ? <PreBlock>{pretty}</PreBlock> : null}
    </div>
  );
}

function formatSubtype(subtype: JsonSubtype): string {
  return subtype.replace(/_/g, " ");
}

function renderJsonSubtype(subtype: JsonSubtype, parsed: unknown) {
  switch (subtype) {
    case "stage_status":
      return <StageStatusJsonBlock parsed={parsed} />;
    case "run_record":
      return <RunRecordJsonBlock parsed={parsed} />;
    case "cli_invocation":
      return <CliInvocationJsonBlock parsed={parsed} />;
    case "tool_invocation":
      return <ToolInvocationJsonBlock parsed={parsed} />;
    case "timing":
      return <TimingJsonBlock parsed={parsed} />;
    case "events_array":
      return <EventsArrayJsonBlock parsed={parsed} />;
    case "parallel_results":
      return <ParallelResultsJsonBlock parsed={parsed} />;
    case "checkpoint":
      return <CheckpointJsonBlock parsed={parsed} />;
    case "live_event":
      return <LiveEventJsonBlock parsed={parsed} />;
    case "live_status_paths":
      return <LiveStatusPathsJsonBlock parsed={parsed} />;
    case "live_io_heartbeat":
      return <LiveIoHeartbeatJsonBlock parsed={parsed} />;
    case "live_failure":
      return <LiveFailureJsonBlock parsed={parsed} />;
    case "live_retry":
      return <LiveRetryJsonBlock parsed={parsed} />;
    case "manifest":
      return <ManifestJsonBlock parsed={parsed} />;
    case "final":
      return <FinalJsonBlock parsed={parsed} />;
    case "preflight_report":
      return <PreflightJsonBlock parsed={parsed} />;
    case "model_catalog":
      return <ModelCatalogJsonBlock parsed={parsed} />;
    case "run_config":
      return <RunConfigJsonBlock parsed={parsed} />;
    case "partial_status":
      return <PartialStatusJsonBlock parsed={parsed} />;
    default:
      return <GenericJsonBlock parsed={parsed} />;
  }
}

function toObject(parsed: unknown): Record<string, unknown> | null {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `Object(${keys.length}): ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""}`;
  }
  return String(value);
}

function GenericJsonBlock({ parsed }: { parsed: unknown }) {
  if (Array.isArray(parsed)) {
    return (
      <div className="space-y-2 text-xs">
        <div className="text-gray-500">Array items: {parsed.length}</div>
        <div className="border border-gray-800 rounded p-2 bg-gray-950/50 space-y-1">
          {parsed.slice(0, 20).map((item, i) => (
            <div key={i} className="text-gray-300 font-mono">
              [{i}] {compactValue(item)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const obj = toObject(parsed);
  if (!obj) {
    return <div className="text-xs text-gray-500 p-2 border border-gray-800 rounded bg-gray-950/50">Generic JSON value.</div>;
  }
  const entries = Object.entries(obj);
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-500">Object keys: {entries.length}</div>
      <div className="border border-gray-800 rounded p-2 bg-gray-950/50 space-y-1">
        {entries.slice(0, 40).map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <span className="text-gray-500 font-mono min-w-[80px] sm:min-w-[160px]">{k}</span>
            <span className="text-gray-300 whitespace-pre-wrap break-all">{compactValue(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StageStatusJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse stage status object.</div>;
  const status = String(obj.status || "unknown");
  const notes = typeof obj.notes === "string" ? obj.notes : "";
  const updates = obj.context_updates && typeof obj.context_updates === "object" ? Object.entries(obj.context_updates as Record<string, unknown>) : [];
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">Status: <span className="font-mono">{status}</span></div>
      <div className="text-gray-500">Context updates: {updates.length}</div>
      {updates.length > 0 ? (
        <div className="border border-gray-800 rounded p-2 space-y-1 bg-gray-950/50">
          {updates.slice(0, 20).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="text-gray-500 font-mono min-w-[80px] sm:min-w-[120px]">{k}</span>
              <span className="text-gray-300 whitespace-pre-wrap">{typeof v === "string" ? v : JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {notes ? <div className="text-xs text-gray-300 whitespace-pre-wrap">{notes}</div> : null}
    </div>
  );
}

function RunRecordJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse run record.</div>;
  const status = String(obj.status || "unknown");
  const runId = String(obj.id || obj.run_id || "");
  const currentNode = String(obj.current_node || "");
  const started = String(obj.started_at || "");
  const finished = String(obj.finished_at || "");
  const heartbeat = String(obj.last_heartbeat || "");
  const repo = String(obj.repo || "");
  const dot = String(obj.dot_file || "");
  const artifacts = Array.isArray(obj.artifacts) ? obj.artifacts : [];
  const params = toObject(obj.params);
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">
        Run: <span className="font-mono">{runId || "(unknown)"}</span> | Status: <span className="font-mono">{status}</span>
      </div>
      <div className="text-gray-500 break-all">Repo: {repo}</div>
      <div className="text-gray-500 break-all flex items-center gap-1.5">Graph: {dot}</div>
      <div className="text-gray-500">Current node: {currentNode || "-"}</div>
      <div className="text-gray-500">Started: {formatTs(started) || "-"}</div>
      <div className="text-gray-500">Finished: {formatTs(finished) || "-"}</div>
      <div className="text-gray-500">Last heartbeat: {formatTs(heartbeat) || "-"}</div>
      <div className="text-gray-500">Artifacts: {artifacts.length}</div>
      {params ? (
        <div className="border border-gray-800 rounded p-2 bg-gray-950/50 space-y-1">
          <div className="text-gray-400">params</div>
          {Object.entries(params).slice(0, 20).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="text-gray-500 font-mono min-w-[80px] sm:min-w-[120px]">{k}</span>
              <span className="text-gray-300 whitespace-pre-wrap break-all">{compactValue(v)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CliInvocationJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse CLI invocation object.</div>;
  const provider = String(obj.provider || "unknown");
  const model = String(obj.model || "unknown");
  const promptBytes = Number(obj.prompt_bytes || 0);
  const argv = Array.isArray(obj.argv) ? obj.argv.slice(0, 10).map(String) : [];
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">Provider: {provider} | Model: {model}</div>
      <div className="text-xs text-gray-500">Prompt bytes: {promptBytes.toLocaleString()}</div>
      {argv.length > 0 ? <PreBlock>{argv.join("\n")}</PreBlock> : null}
    </div>
  );
}

function ToolInvocationJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse tool invocation object.</div>;
  const tool = String(obj.tool || "unknown");
  const cmd = String(obj.command || "");
  const cwd = String(obj.working_dir || "");
  const timeout = Number(obj.timeout_ms || 0);
  const argv = Array.isArray(obj.argv) ? obj.argv.slice(0, 12).map(String) : [];
  const shellView = argv.length > 0 ? argv.join(" ") : cmd;
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">Tool: <span className="font-mono">{tool}</span></div>
      <div className="text-gray-500">Timeout: {timeout} ms</div>
      <div className="text-gray-500 break-all">Working dir: {cwd}</div>
      {cmd ? (
        <div className="space-y-1">
          <div className="text-gray-300">Command:</div>
          <ShellCommandBlock commandText={cmd} />
        </div>
      ) : null}
      {argv.length > 0 ? (
        <div className="space-y-1">
          <div className="text-gray-300">argv:</div>
          <div className="space-y-1">
            {argv.map((arg, i) => (
              <div key={`${arg}-${i}`} className="font-mono text-[11px]">
                <span className="text-gray-600 mr-2">[{i}]</span>
                <ShellCommandBlock commandText={arg} inline />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {shellView ? (
        <div className="space-y-1">
          <div className="text-gray-300">Shell view:</div>
          <ShellCommandBlock commandText={shellView} />
        </div>
      ) : null}
    </div>
  );
}

function TimingJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse timing object.</div>;
  const ms = Number(obj.duration_ms || 0);
  const exit = Number(obj.exit_code ?? 0);
  const timedOut = Boolean(obj.timed_out);
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">Duration: {(ms / 1000).toFixed(2)}s | Exit: {exit}</div>
      <div className="text-xs text-gray-500">Timed out: {timedOut ? "yes" : "no"}</div>
    </div>
  );
}

function EventsArrayJsonBlock({ parsed }: { parsed: unknown }) {
  if (!Array.isArray(parsed)) return <div className="text-xs text-gray-500">Unable to parse events array.</div>;
  const counts = new Map<string, number>();
  const recent: Array<Record<string, unknown>> = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const key = String(obj.type || "unknown");
    counts.set(key, (counts.get(key) || 0) + 1);
    if (recent.length < 20) recent.push(obj);
  }
  const summary = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`);
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500">Events: {parsed.length}</div>
      {summary.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {summary.map((line, i) => (
            <div key={i} className="border border-gray-800 rounded px-2 py-1 text-gray-300 bg-gray-950/50">{line}</div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-gray-500">(no typed events)</div>
      )}
      {recent.length > 0 ? (
        <>
          <div className="text-xs text-gray-500">Recent events</div>
          <div className="space-y-1 max-h-[40vh] sm:max-h-[260px] overflow-auto border border-gray-800 rounded p-2 bg-gray-950/40">
            {recent.map((event, i) => (
              <div key={i} className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap">
                {formatTs(event.ts || event.timestamp)} {String(event.type || "event")} {String(event.node_id || event.from_node || "")}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ParallelResultsJsonBlock({ parsed }: { parsed: unknown }) {
  if (!Array.isArray(parsed)) return <div className="text-xs text-gray-500">Unable to parse parallel results array.</div>;
  const rows = parsed
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => `${String(x.branch_key || x.branch_name || "?")} | ${String(x.outcome || "?")} | ${String(x.last_node_id || "-")}`);
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500">Branches: {rows.length}</div>
      <PreBlock>{rows.join("\n")}</PreBlock>
    </div>
  );
}

function CheckpointJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse checkpoint object.</div>;
  const current = String(obj.current_node || "unknown");
  const completed = Array.isArray(obj.completed_nodes) ? obj.completed_nodes.length : 0;
  const retries = obj.node_retries && typeof obj.node_retries === "object" ? Object.keys(obj.node_retries as Record<string, unknown>).length : 0;
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">Current node: {current}</div>
      <div className="text-xs text-gray-500">Completed: {completed} | Retry entries: {retries}</div>
    </div>
  );
}

function LiveEventJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse live event object.</div>;
  const flow = `${String(obj.from_node || "?")} -> ${String(obj.to_node || "?")}`;
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">{String(obj.event || "event")} | {flow}</div>
      <div className="text-xs text-gray-500">{formatTs(obj.ts)}</div>
    </div>
  );
}

function LiveStatusPathsJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse live status-path event.</div>;
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">Event: {String(obj.event || "")} | Node: {String(obj.node_id || "")}</div>
      <div className="text-gray-500 break-all">status_path: {String(obj.status_path || "")}</div>
      <div className="text-gray-500 break-all">fallback: {String(obj.status_fallback_path || "")}</div>
      <div className="text-gray-500">{formatTs(obj.ts)}</div>
    </div>
  );
}

function LiveIoHeartbeatJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse live heartbeat event.</div>;
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">Event: {String(obj.event || "")} | Node: {String(obj.node_id || "")}</div>
      <div className="text-gray-500">
        elapsed={String(obj.elapsed_s || "")}s stdout={String(obj.stdout_bytes || 0)}B stderr={String(obj.stderr_bytes || 0)}B
      </div>
      <div className="text-gray-500">{formatTs(obj.ts)}</div>
    </div>
  );
}

function LiveFailureJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse live failure event.</div>;
  return (
    <div className="space-y-2 text-xs">
      <div className="text-red-300">Failure class: {String(obj.failure_class || "unknown")}</div>
      <div className="text-gray-200">Reason: {String(obj.failure_reason || "")}</div>
      <div className="text-gray-500">Node: {String(obj.node_id || "")} {"->"} Target: {String(obj.target_node || "")}</div>
      <div className="text-gray-500">{formatTs(obj.ts)}</div>
    </div>
  );
}

function LiveRetryJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse live retry event.</div>;
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">Retry event: {String(obj.event || "")}</div>
      <div className="text-gray-500">Node: {String(obj.node_id || "")}</div>
      <div className="text-gray-500">Attempt: {String(obj.attempt || 0)} / {String(obj.max || 0)}</div>
      <div className="text-gray-500">{formatTs(obj.ts)}</div>
    </div>
  );
}

function ManifestJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse manifest object.</div>;
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">Run: {String(obj.run_id || "")}</div>
      <div className="text-xs text-gray-500">Graph: {String(obj.graph_name || "")}</div>
      <div className="text-xs text-gray-500">Repo: {String(obj.repo_path || "")}</div>
    </div>
  );
}

function FinalJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse final object.</div>;
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">Status: {String(obj.status || "")}</div>
      <div className="text-xs text-gray-500">Commit: {String(obj.final_git_commit_sha || "")}</div>
      <div className="text-xs text-gray-500">Completed at: {formatTs(obj.timestamp)}</div>
    </div>
  );
}

function PreflightJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse preflight report object.</div>;
  const checks = Array.isArray(obj.checks) ? obj.checks.length : 0;
  const checkRows = Array.isArray(obj.checks) ? obj.checks.slice(0, 20) : [];
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">Checks: {checks}</div>
      <div className="text-xs text-gray-500">Generated: {String(obj.generated_at || "")}</div>
      <div className="text-xs text-gray-500">Summary: {String(obj.summary || "")}</div>
      {checkRows.length > 0 ? (
        <div className="border border-gray-800 rounded p-2 bg-gray-950/50 space-y-1">
          {checkRows.map((row, i) => {
            const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
            return (
              <div key={i} className="text-[11px] text-gray-300">
                {String(r.name || r.check || `check-${i}`)}: {String(r.status || r.result || "unknown")}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ModelCatalogJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse model catalog object.</div>;
  const data = Array.isArray(obj.data) ? obj.data : [];
  const first = data[0] && typeof data[0] === "object" ? Object.keys(data[0] as Record<string, unknown>).slice(0, 8).join(", ") : "";
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-200">Model entries: {data.length}</div>
      {first ? <div className="text-xs text-gray-500">First entry keys: {first}</div> : null}
    </div>
  );
}

function RunConfigJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse run config object.</div>;
  const repos = obj.repo && typeof obj.repo === "object" ? Object.keys(obj.repo as Record<string, unknown>) : [];
  const llmProviders = obj.llm && typeof obj.llm === "object" ? Object.keys(obj.llm as Record<string, unknown>) : [];
  const runtimePolicy = obj.runtime_policy && typeof obj.runtime_policy === "object" ? Object.keys(obj.runtime_policy as Record<string, unknown>) : [];
  const preflight = obj.preflight && typeof obj.preflight === "object" ? Object.keys(obj.preflight as Record<string, unknown>) : [];
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">Run config version: {String(obj.version || "")}</div>
      <div className="text-gray-500">Repos configured: {repos.length}</div>
      <div className="text-gray-500">LLM providers: {llmProviders.join(", ") || "(none)"}</div>
      <div className="text-gray-500">Has runtime policy: {obj.runtime_policy ? "yes" : "no"}</div>
      <div className="text-gray-500">Has preflight: {obj.preflight ? "yes" : "no"}</div>
      {repos.length > 0 ? (
        <div className="border border-gray-800 rounded p-2 bg-gray-950/50">
          <div className="text-gray-400 mb-1">repo keys</div>
          <div className="text-gray-300">{repos.join(", ")}</div>
        </div>
      ) : null}
      {llmProviders.length > 0 ? (
        <div className="border border-gray-800 rounded p-2 bg-gray-950/50">
          <div className="text-gray-400 mb-1">llm providers</div>
          <div className="text-gray-300">{llmProviders.join(", ")}</div>
        </div>
      ) : null}
      {runtimePolicy.length > 0 ? (
        <div className="border border-gray-800 rounded p-2 bg-gray-950/50">
          <div className="text-gray-400 mb-1">runtime policy keys</div>
          <div className="text-gray-300">{runtimePolicy.join(", ")}</div>
        </div>
      ) : null}
      {preflight.length > 0 ? (
        <div className="border border-gray-800 rounded p-2 bg-gray-950/50">
          <div className="text-gray-400 mb-1">preflight keys</div>
          <div className="text-gray-300">{preflight.join(", ")}</div>
        </div>
      ) : null}
    </div>
  );
}

function PartialStatusJsonBlock({ parsed }: { parsed: unknown }) {
  const obj = toObject(parsed);
  if (!obj) return <div className="text-xs text-gray-500">Unable to parse partial status object.</div>;
  return (
    <div className="space-y-2 text-xs">
      <div className="text-gray-200">Node: {String(obj.node_id || "")}</div>
      <div className="text-gray-500">files_changed: {String(obj.files_changed || 0)}</div>
      <div className="text-gray-500">harvested: {String(obj.harvested || 0)}</div>
    </div>
  );
}

function YamlBlock({ text }: { text: string }) {
  const keys = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes(":"))
    .slice(0, 20);
  return (
    <div className="flex flex-col min-h-0">
      {keys.length > 0 ? (
        <div className="text-xs text-gray-500 px-1 pb-1">
          YAML fields: {keys.length >= 20 ? "20+" : keys.length}
        </div>
      ) : null}
      <PreBlock>{text}</PreBlock>
    </div>
  );
}

function DotBlock({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);

  if (showRaw) {
    return (
      <div className="flex flex-col min-h-0">
        <div className="flex justify-between items-center px-1 pb-2">
          <div className="text-xs text-gray-500">DOT source</div>
          <button
            className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
            onClick={() => setShowRaw(false)}
          >
            Show graph
          </button>
        </div>
        <PreBlock>{text}</PreBlock>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex justify-between items-center px-1 pb-2">
        <div className="text-xs text-gray-500">DOT graph</div>
        <button
          className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
          onClick={() => setShowRaw(true)}
        >
          Show source
        </button>
      </div>
      <div className="min-h-[300px] border border-gray-800 rounded overflow-hidden">
        <DotPreview dot={text} />
      </div>
    </div>
  );
}

function PreBlock({ children }: { children: string }) {
  return (
    <pre className="flex-1 overflow-auto p-3 text-xs text-gray-300 font-mono whitespace-pre-wrap bg-gray-950 rounded">
      {children}
    </pre>
  );
}

function MarkdownBlock({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const lines = text.split("\n");
  const headingCount = lines.filter((line) => line.startsWith("#")).length;
  const bulletCount = lines.filter((line) => line.trim().startsWith("- ")).length;
  if (showRaw) {
    return (
      <div className="flex flex-col min-h-0">
        <div className="flex justify-between items-center pb-2">
          <div className="text-xs text-gray-500">Markdown raw source</div>
          <button
            className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
            onClick={() => setShowRaw(false)}
          >
            Show rendered
          </button>
        </div>
        <PreBlock>{text}</PreBlock>
      </div>
    );
  }
  return (
    <div className="p-3 text-xs text-gray-300 bg-gray-950 rounded space-y-1">
      <div className="flex justify-between items-center pb-1">
        <div className="text-[11px] text-gray-500">
          {headingCount} headings, {bulletCount} bullets
        </div>
        <button
          className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
          onClick={() => setShowRaw(true)}
        >
          Show raw
        </button>
      </div>
      <MarkdownContent content={text} className="text-xs" />
    </div>
  );
}

function DiffBlock({ text }: { text: string }) {
  const [changesOnly, setChangesOnly] = useState(false);
  const lines = text.split("\n");
  const adds = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const dels = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const hunks = lines.filter((line) => line.startsWith("@@")).length;
  const visible = changesOnly
    ? lines.filter((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("@@"))
    : lines;
  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between pb-2">
        <div className="text-[11px] text-gray-500">
          +{adds} / -{dels} across {hunks} hunks
        </div>
        <button
          className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
          onClick={() => setChangesOnly((v) => !v)}
        >
          {changesOnly ? "Show full patch" : "Show changes only"}
        </button>
      </div>
      <pre className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre bg-gray-950 rounded">
        {visible.map((line, i) => {
          let cls = "text-gray-300";
          if (line.startsWith("+")) cls = "text-green-400";
          else if (line.startsWith("-")) cls = "text-red-400";
          else if (line.startsWith("@@")) cls = "text-blue-400";
          return (
            <div key={i} className={cls}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const toolOutput = useMemo(() => parseToolOutputText(text), [text]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q ? lines.filter((line) => line.toLowerCase().includes(q)) : lines,
    [lines, q]
  );
  if (toolOutput && !showRaw) {
    return (
      <div className="flex flex-col min-h-0 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-500">
            Fingerprint: tool_output ({toolOutput.sections.length} sections, {toolOutput.heartbeats.length} heartbeats)
          </div>
          <button
            className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
            onClick={() => setShowRaw(true)}
          >
            Show raw
          </button>
        </div>
        {toolOutput.summaryLines.length > 0 ? (
          <div className="border border-gray-800 rounded p-2 bg-gray-950/60 space-y-1">
            {toolOutput.summaryLines.map((line, i) => (
              <div key={i} className="text-xs text-gray-300 whitespace-pre-wrap">
                {line}
              </div>
            ))}
          </div>
        ) : null}
        {toolOutput.sections.length > 0 ? (
          <div className="space-y-2">
            {toolOutput.sections.map((section, i) => (
              <div key={`${section.title}-${i}`} className="border border-gray-800 rounded p-2 bg-gray-950/50">
                <div className="text-xs text-cyan-300 mb-1">{section.title}</div>
                {section.lines.map((line, j) => (
                  <div key={j} className="text-[11px] text-gray-300 whitespace-pre-wrap">{line}</div>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        {toolOutput.heartbeats.length > 0 ? (
          <div className="border border-gray-800 rounded p-2 bg-gray-950/50">
            <div className="text-xs text-purple-300 mb-2">Inline monitor heartbeats</div>
            <div className="space-y-1">
              {toolOutput.heartbeats.map((hb, i) => (
                <div key={`${hb.tag}-${i}`} className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap">
                  [{hb.tag}] {hb.payload}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 pb-2">
        <input
          className="flex-1 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300"
          placeholder="Search lines..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
          onClick={() => setWrap((w) => !w)}
        >
          {wrap ? "Wrap: on" : "Wrap: off"}
        </button>
        {toolOutput ? (
          <button
            className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Show formatted" : "Show raw"}
          </button>
        ) : null}
      </div>
      <div className="text-[11px] text-gray-500 pb-1">
        {visible.length} lines{q ? ` (filtered from ${lines.length})` : ""}
      </div>
      <pre className={`flex-1 overflow-auto p-3 text-xs text-gray-300 font-mono bg-gray-950 rounded ${wrap ? "whitespace-pre-wrap" : "whitespace-pre"}`}>
        {visible.map((line, i) => (
          <div key={i}>
            <span className="text-gray-600 pr-2 select-none">{String(i + 1).padStart(4, " ")}</span>
            {line}
          </div>
        ))}
      </pre>
    </div>
  );
}

type ToolOutputSection = {
  title: string;
  lines: string[];
};

type ToolOutputHeartbeat = {
  tag: string;
  payload: string;
};

type ToolOutputFingerprint = {
  summaryLines: string[];
  sections: ToolOutputSection[];
  heartbeats: ToolOutputHeartbeat[];
};

function parseToolOutputText(text: string): ToolOutputFingerprint | null {
  const normalized = text.replace(/\\n/g, "\n");
  const hasMarkers =
    normalized.includes("tool.output:") ||
    normalized.includes("tool completed") ||
    normalized.includes("[inline-monitor]") ||
    normalized.includes("=== ");
  if (!hasMarkers) return null;

  const summaryLines: string[] = [];
  const sections: ToolOutputSection[] = [];
  const heartbeats: ToolOutputHeartbeat[] = [];
  let currentSection: ToolOutputSection | null = null;

  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = line.match(/^===\s*(.+?)\s*===$/);
    if (heading) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: heading[1], lines: [] };
      continue;
    }
    const heartbeat = line.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (heartbeat) {
      heartbeats.push({ tag: heartbeat[1], payload: heartbeat[2] });
      continue;
    }
    if (line.startsWith("tool completed") || line.startsWith("tool.output:")) {
      summaryLines.push(line);
      continue;
    }
    if (currentSection) {
      currentSection.lines.push(line);
    } else if (summaryLines.length < 8) {
      summaryLines.push(line);
    }
  }
  if (currentSection) sections.push(currentSection);

  if (summaryLines.length === 0 && sections.length === 0 && heartbeats.length === 0) {
    return null;
  }
  return { summaryLines, sections, heartbeats };
}

function PidBlock({ text }: { text: string }) {
  const pid = text.trim();
  const isNumeric = /^[0-9]+$/.test(pid);
  return (
    <div className="p-3 border border-gray-800 rounded bg-gray-950/60 space-y-2">
      <div className="text-xs text-gray-500">PID file</div>
      <div className="text-sm font-mono text-gray-200">{pid || "(empty)"}</div>
      <div className="text-xs text-gray-500">Format: {isNumeric ? "valid numeric pid" : "non-numeric content"}</div>
    </div>
  );
}

function BinaryBlock({ fileName, fileUrl, mime }: { fileName: string; fileUrl?: string; mime?: string }) {
  return (
    <div className="p-3 text-xs text-gray-400 space-y-2">
      <div>
        Binary preview is not available for <span className="font-mono text-gray-200">{fileName}</span>.
      </div>
      <div className="text-[11px] text-gray-500">
        MIME: <span className="font-mono">{mime || "unknown"}</span>
      </div>
      {fileUrl ? (
        <div className="flex items-center gap-2">
          <a
            className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open raw
          </a>
          <a
            className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
            href={fileUrl}
            download={fileName}
          >
            Download
          </a>
        </div>
      ) : null}
    </div>
  );
}

function HtmlBlock({ text }: { text: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div className="flex flex-col min-h-0 gap-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">HTML document</div>
        <button
          className="text-xs px-2 py-1 border border-gray-700 rounded text-gray-300 hover:bg-gray-800"
          onClick={() => setMode((m) => (m === "preview" ? "source" : "preview"))}
        >
          {mode === "preview" ? "Show source" : "Show preview"}
        </button>
      </div>
      {mode === "preview" ? (
        <iframe
          title="html-preview"
          sandbox=""
          srcDoc={text}
          className="w-full min-h-[250px] sm:min-h-[420px] border border-gray-800 rounded bg-white"
        />
      ) : (
        <PreBlock>{text}</PreBlock>
      )}
    </div>
  );
}

function XmlBlock({ text }: { text: string }) {
  const topTag = (text.match(/<([A-Za-z_][\w:.-]*)/) || [])[1] || "unknown";
  return (
    <div className="flex flex-col min-h-0">
      <div className="text-xs text-gray-500 px-1 pb-1">XML root: {topTag}</div>
      <PreBlock>{text}</PreBlock>
    </div>
  );
}

type ShellTokenKind = "bin" | "flag" | "path" | "env" | "operator" | "string" | "other";

function ShellCommandBlock({ commandText, inline = false }: { commandText: string; inline?: boolean }) {
  const tokens = tokenizeShell(commandText);
  if (tokens.length === 0) {
    return <span className="text-gray-500">(empty)</span>;
  }
  return (
    <div className={inline ? "inline" : "rounded border border-gray-800 bg-gray-950/70 p-2 overflow-auto"}>
      {tokens.map((t, idx) => (
        <span key={`${t.text}-${idx}`} className={shellTokenClass(t.kind)}>
          {t.text}
          {idx < tokens.length - 1 ? " " : ""}
        </span>
      ))}
    </div>
  );
}

function shellTokenClass(kind: ShellTokenKind): string {
  switch (kind) {
    case "bin":
      return "text-green-300";
    case "flag":
      return "text-amber-300";
    case "path":
      return "text-cyan-300";
    case "env":
      return "text-fuchsia-300";
    case "operator":
      return "text-gray-400";
    case "string":
      return "text-emerald-200";
    default:
      return "text-gray-200";
  }
}

function tokenizeShell(commandText: string): Array<{ text: string; kind: ShellTokenKind }> {
  const raw = commandText.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return raw.map((tok, idx) => {
    let kind: ShellTokenKind = "other";
    if (/^(?:\|\||&&|\||;|>|>>|<)$/.test(tok)) kind = "operator";
    else if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(tok) || /\$[A-Za-z_][A-Za-z0-9_]*/.test(tok)) kind = "env";
    else if (/^-{1,2}[A-Za-z0-9-]+$/.test(tok)) kind = "flag";
    else if (/^["'].*["']$/.test(tok)) kind = "string";
    else if (/^\/|^\.\.?\//.test(tok)) kind = "path";
    else if (idx === 0) kind = "bin";
    return { text: tok, kind };
  });
}

// ---------------------------------------------------------------------------
// Docker BuildKit plain-progress output renderer
// ---------------------------------------------------------------------------

type DockerBuildStep = {
  id: string;
  title: string;
  bodyLines: string[];
  status: "done" | "error" | "cached" | "unknown";
  duration?: string;
};

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function parseDockerBuildSteps(text: string): DockerBuildStep[] {
  const clean = stripAnsi(text);
  const lines = clean.split("\n");
  const stepMap = new Map<string, DockerBuildStep>();
  const order: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(#\d+)\s+(.*)/);
    if (!m) continue;
    const id = m[1];
    const rest = m[2];

    if (!stepMap.has(id)) {
      stepMap.set(id, { id, title: rest, bodyLines: [], status: "unknown" });
      order.push(id);
    }
    const step = stepMap.get(id)!;

    const doneMatch = rest.match(/^DONE\s+(.+)/);
    if (doneMatch) {
      step.status = "done";
      step.duration = doneMatch[1].trim();
    } else if (/^(ERROR[: ]|CANCELED)/.test(rest)) {
      step.status = "error";
      step.bodyLines.push(rest);
    } else if (rest.trim() === "CACHED") {
      step.status = "cached";
    } else if (rest !== step.title) {
      step.bodyLines.push(rest);
    }
  }

  return order.map((id) => stepMap.get(id)!);
}

function DockerBuildBlock({ text }: { text: string }) {
  const steps = useMemo(() => parseDockerBuildSteps(text), [text]);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    new Set(steps.filter((s) => s.status === "error").map((s) => s.id))
  );
  const [showRaw, setShowRaw] = useState(false);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const doneCount = steps.filter((s) => s.status === "done").length;
  const errorCount = steps.filter((s) => s.status === "error").length;
  const cachedCount = steps.filter((s) => s.status === "cached").length;

  if (steps.length === 0) return <PreBlock>{text}</PreBlock>;

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-3 pb-2 text-[11px] flex-wrap">
        <span className="text-gray-400">Fingerprint: docker-build</span>
        <span className="text-gray-500">{steps.length} steps</span>
        {doneCount > 0 && <span className="text-green-400">{doneCount} done</span>}
        {cachedCount > 0 && <span className="text-gray-500">{cachedCount} cached</span>}
        {errorCount > 0 && <span className="text-red-400">{errorCount} error</span>}
        <button
          className="ml-auto text-[10px] px-2 py-0.5 border border-gray-700 rounded text-gray-400 hover:bg-gray-800"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Hide raw" : "Show raw"}
        </button>
      </div>
      {showRaw ? (
        <PreBlock>{text}</PreBlock>
      ) : (
        <div className="bg-gray-950 rounded overflow-auto max-h-[60vh] sm:max-h-[520px]">
          {steps.map((step) => {
            const isOpen = expanded.has(step.id);
            const hasBody = step.bodyLines.length > 0;
            const statusColor =
              step.status === "done"
                ? "text-green-400"
                : step.status === "error"
                ? "text-red-400"
                : step.status === "cached"
                ? "text-gray-600"
                : "text-amber-400";
            const statusIcon =
              step.status === "done"
                ? "✓"
                : step.status === "error"
                ? "✗"
                : step.status === "cached"
                ? "○"
                : "·";
            return (
              <div key={step.id} className="border-b border-gray-900 last:border-0">
                <button
                  className="w-full flex items-baseline gap-2 px-3 py-1.5 text-left hover:bg-gray-900/60 transition-colors disabled:cursor-default"
                  onClick={() => hasBody && toggle(step.id)}
                  disabled={!hasBody}
                >
                  <span className={`text-[11px] font-mono shrink-0 w-4 ${statusColor}`}>{statusIcon}</span>
                  <span className="text-[11px] font-mono text-gray-600 shrink-0">{step.id}</span>
                  <span className="text-[11px] text-gray-300 truncate flex-1">{step.title}</span>
                  {step.duration && (
                    <span className="text-[10px] text-gray-600 shrink-0 font-mono">{step.duration}</span>
                  )}
                  {hasBody && (
                    <span className="text-[10px] text-gray-600 shrink-0">{isOpen ? "▲" : "▼"}</span>
                  )}
                </button>
                {isOpen && hasBody && (
                  <div className="px-3 pb-2 pt-0.5 bg-gray-950/70">
                    <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap">
                      {step.bodyLines.join("\n")}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
