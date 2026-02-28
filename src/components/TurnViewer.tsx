import { useState } from "react";
import type { TurnsData, TurnUser, TurnAssistant, ToolCallRecord, PricingEstimate } from "../lib/types";
import { FileVisualizer } from "./FileVisualizers";
import MarkdownContent from "./MarkdownContent";

// ── Tool argument helpers ────────────────────────────────────────────────────

/** The filename to use for fingerprinting a tool's OUTPUT */
function outputFileName(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file": {
      const p = String(args.file_path ?? args.path ?? "");
      return p ? baseName(p) : "output.txt";
    }
    case "list_dir":
      return "listing.json";
    case "glob":
      return "listing.json";
    case "grep":
      return "grep.log";
    case "shell":
    case "bash":
      return "output.log";
    default:
      return "output.log";
  }
}

/** The filename to use for fingerprinting a write_file / edit_file CONTENT arg */
function writeFileName(args: Record<string, unknown>): string {
  const p = String(args.path ?? args.file_path ?? args.target_file ?? "");
  return p ? baseName(p) : "file.txt";
}

function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** Short human-readable summary for the tool call header */
function toolLabel(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return shortPath(String(args.file_path ?? args.path ?? args.target_file ?? ""));
    case "read_many_files": {
      const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
      if (paths.length === 0) return "";
      return paths.length === 1 ? shortPath(paths[0]) : `${shortPath(paths[0])} +${paths.length - 1}`;
    }
    case "list_dir":
      return shortPath(String(args.path ?? "."));
    case "glob":
      return String(args.pattern ?? "");
    case "grep": {
      const pat = String(args.pattern ?? args.regex ?? "");
      const p = String(args.path ?? args.dir ?? "");
      return [pat && `/${pat}/`, p && shortPath(p)].filter(Boolean).join(" in ");
    }
    case "shell":
    case "bash": {
      const cmd = String(args.command ?? "");
      return cmd.length > 72 ? cmd.slice(0, 72) + "…" : cmd;
    }
    default: {
      // First string-valued arg as fallback
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.length > 0)
          return v.length > 60 ? v.slice(0, 60) + "…" : v;
      }
      return "";
    }
  }
}

function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-2).join("/");
}

// ── Icons ───────────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  read_many_files: "📚",
  write_file: "✏️",
  edit_file: "✂️",
  list_dir: "📁",
  glob: "🔍",
  grep: "🔎",
  shell: "💻",
  bash: "💻",
};

// ── ToolCallBlock ────────────────────────────────────────────────────────────

function ToolCallBlock({ tc }: { tc: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const args = tc.arguments ?? {};
  const label = toolLabel(tc.tool_name, args);
  const icon = TOOL_ICONS[tc.tool_name] ?? "⚙️";

  const isWrite = tc.tool_name === "write_file";
  const isEdit = tc.tool_name === "edit_file";

  // For write_file: render the content arg as the primary content
  const writeContent = isWrite ? String(args.content ?? args.text ?? "") : null;
  const writeFn = isWrite ? writeFileName(args) : null;

  // For edit_file: render old_str → new_str as a synthetic diff
  const editOld = isEdit ? String(args.old_str ?? args.old_string ?? "") : null;
  const editNew = isEdit ? String(args.new_str ?? args.new_string ?? "") : null;
  const editFn = isEdit ? writeFileName(args) : null;
  const editDiff = isEdit && editOld !== null && editNew !== null
    ? buildPseudoDiff(editFn ?? "file", editOld, editNew)
    : null;

  const hasExpandable = isWrite ? (writeContent?.length ?? 0) > 0
    : isEdit ? editDiff !== null
    : tc.output.length > 0;

  const errStyle = tc.is_error
    ? "border-red-800/50 bg-red-950/20"
    : "border-gray-800/60 bg-gray-900/20";

  return (
    <div className={`rounded border text-xs ${errStyle}`}>
      {/* Header */}
      <button
        className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.03] rounded"
        onClick={() => hasExpandable && setOpen((o) => !o)}
      >
        <span className="shrink-0 mt-0.5">{icon}</span>
        <span className="font-mono font-medium text-blue-300 shrink-0">{tc.tool_name}</span>
        {label && (
          <span className="text-gray-500 min-w-0 truncate flex-1">{label}</span>
        )}
        {tc.is_error && (
          <span className="text-red-400 text-[10px] shrink-0 mt-0.5">error</span>
        )}
        {hasExpandable && (
          <span className="text-gray-700 text-[10px] shrink-0 mt-0.5 ml-auto">
            {open ? "▲" : "▼"}
          </span>
        )}
      </button>

      {/* Expandable body */}
      {open && hasExpandable && (
        <div className="border-t border-gray-800/40">
          {isWrite && writeContent ? (
            <div className="p-1">
              <div className="text-[10px] text-gray-600 px-1 pb-0.5">
                writing {String(args.path ?? args.file_path ?? writeFn)}
              </div>
              <FileVisualizer fileName={writeFn!} content={writeContent} />
            </div>
          ) : isEdit && editDiff ? (
            <div className="p-1">
              <div className="text-[10px] text-gray-600 px-1 pb-0.5">
                editing {String(args.path ?? args.file_path ?? editFn)}
              </div>
              <FileVisualizer fileName="edit.diff" content={editDiff} />
            </div>
          ) : (
            <div className="p-1">
              <FileVisualizer
                fileName={outputFileName(tc.tool_name, args)}
                content={tc.output}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Build a unified diff string from old/new content for edit_file visualization */
function buildPseudoDiff(fileName: string, oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const hdr = `--- a/${fileName}\n+++ b/${fileName}\n@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  const removed = oldLines.map((l) => `- ${l}`).join("\n");
  const added = newLines.map((l) => `+ ${l}`).join("\n");
  return `${hdr}\n${removed}\n${added}`;
}

// ── UserTurn ─────────────────────────────────────────────────────────────────

function UserTurn({ turn }: { turn: TurnUser }) {
  const [open, setOpen] = useState(false);

  // Try to extract just the task instruction — it follows the last "---" or the
  // Kilroy context block which always ends with a blank line before the task text.
  const taskText = extractTask(turn.text);

  return (
    <div className="border border-gray-700/40 rounded bg-gray-800/10">
      {/* Always-visible task preview */}
      {taskText && (
        <div className="px-3 py-2 text-xs text-gray-300 leading-relaxed">
          <MarkdownContent content={taskText} />
        </div>
      )}

      {/* Toggle to show full prompt */}
      <button
        className="w-full flex items-center gap-1.5 px-3 py-1 text-left border-t border-gray-800/40 hover:bg-gray-800/30"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[10px] text-gray-600 flex-1">
          {open ? "Hide full prompt" : "Show full prompt"}
        </span>
        <span className="text-gray-700 text-[10px]">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-gray-800/40 p-2 max-h-[60vh] overflow-auto">
          <FileVisualizer fileName="prompt.md" mime="text/markdown" content={turn.text} />
        </div>
      )}
    </div>
  );
}

/**
 * Extracts the actual task instruction from a kilroy prompt.
 * The prompt has header sections (Input materialization contract, Execution status
 * contract, Kilroy Context). The task starts after the last blank line following
 * the Context block, or after the last occurrence of a line beginning with "You are".
 */
function extractTask(text: string): string {
  // Find last "You are ..." line — that's where the task instruction starts
  const lines = text.split("\n");
  let lastYouAre = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith("You are") || lines[i].trimStart().startsWith("You're")) {
      lastYouAre = i;
      break;
    }
  }
  if (lastYouAre >= 0) {
    return lines.slice(lastYouAre).join("\n").trim();
  }
  // Fallback: last 800 chars
  return text.length > 800 ? "…" + text.slice(-800) : text;
}

// ── AssistantTurn ─────────────────────────────────────────────────────────────

function AssistantTurn({ turn }: { turn: TurnAssistant }) {
  if (turn.steps.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {turn.steps.map((step, i) => {
        if (step.tool_call) {
          return <ToolCallBlock key={i} tc={step.tool_call} />;
        }
        if (step.text) {
          return (
            <div key={i} className="px-1 text-xs text-gray-300">
              <MarkdownContent content={step.text} />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ── Pricing display ──────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd < 0.001) return `<$0.001`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function PricingBadge({ pricing }: { pricing: PricingEstimate }) {
  const [detail, setDetail] = useState(false);
  const hasCost = pricing.estimated_cost_usd !== null;
  return (
    <button
      onClick={() => setDetail((d) => !d)}
      className="group relative text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
      title="Estimated cost (based on text length ÷ 4 token approximation)"
    >
      {hasCost ? (
        <span className="text-emerald-600 group-hover:text-emerald-400">
          ~{fmtCost(pricing.estimated_cost_usd!)}
        </span>
      ) : (
        <span>~{fmtTokens(pricing.estimated_input_tokens + pricing.estimated_output_tokens)} tok</span>
      )}
      {detail && (
        <div className="absolute top-4 right-0 z-10 bg-gray-900 border border-gray-700 rounded p-2 text-[10px] text-gray-400 whitespace-nowrap shadow-lg">
          <div>Model: {pricing.model_id}</div>
          <div>Input:  ~{fmtTokens(pricing.estimated_input_tokens)} tok</div>
          <div>Output: ~{fmtTokens(pricing.estimated_output_tokens)} tok</div>
          {pricing.prompt_price_per_token !== null && (
            <div className="border-t border-gray-700 mt-1 pt-1">
              <div>In:  ${(pricing.prompt_price_per_token * 1_000_000).toFixed(2)}/1M tok</div>
              <div>Out: ${(pricing.completion_price_per_token! * 1_000_000).toFixed(2)}/1M tok</div>
            </div>
          )}
          {hasCost && (
            <div className="text-emerald-500 font-medium">≈ {fmtCost(pricing.estimated_cost_usd!)}</div>
          )}
        </div>
      )}
    </button>
  );
}

// ── TurnViewer (top-level export) ─────────────────────────────────────────────

export function TurnViewer({ data }: { data: TurnsData }) {
  const toolCallCount = data.turns.reduce((acc, t) => {
    if (t.role === "assistant") {
      return acc + t.steps.filter((s) => s.tool_call).length;
    }
    return acc;
  }, 0);

  return (
    <div className="space-y-2 p-2">
      {/* Session metadata */}
      {(data.model || data.profile || data.pricing) && (
        <div className="flex items-center gap-2 text-[10px] text-gray-600 pb-1 border-b border-gray-800/50">
          {data.model && <span>{data.model}</span>}
          {data.profile && <span>· {data.profile}</span>}
          {toolCallCount > 0 && (
            <span>{toolCallCount} tool call{toolCallCount !== 1 ? "s" : ""}</span>
          )}
          {data.pricing && (
            <span className="ml-auto">
              <PricingBadge pricing={data.pricing} />
            </span>
          )}
        </div>
      )}

      {data.turns.map((turn, i) =>
        turn.role === "user" ? (
          <UserTurn key={i} turn={turn} />
        ) : (
          <AssistantTurn key={i} turn={turn} />
        )
      )}

      {data.turns.length === 0 && (
        <div className="text-xs text-gray-600">No turns recorded</div>
      )}
    </div>
  );
}
