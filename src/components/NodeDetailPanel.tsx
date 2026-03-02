import { useMemo } from "react";
import { parseNodeAttrs } from "../lib/dotUtils";

interface NodeDetailPanelProps {
  nodeId: string;
  nodeLabel: string;
  dot: string;
  onClose: () => void;
  editable?: boolean;
  onAttrChange?: (attrName: string, newValue: string) => void;
  onSave?: () => void;
  onRevert?: () => void;
  saving?: boolean;
  dirty?: boolean;
}

export function NodeDetailPanel({
  nodeId,
  nodeLabel,
  dot,
  onClose,
  editable = false,
  onAttrChange,
  onSave,
  onRevert,
  saving = false,
  dirty = false,
}: NodeDetailPanelProps) {
  const attrs = useMemo(() => parseNodeAttrs(dot, nodeId), [dot, nodeId]);
  const isTool = attrs.shape === "parallelogram";
  const isLLM = !isTool && (attrs.shape === "box" || (!attrs.shape && (attrs.prompt != null || attrs.systemPrompt != null)));

  const nodeTypeLabel = isTool ? "Tool node" : isLLM ? "LLM node" : attrs.shape ? `${attrs.shape} node` : "Node";
  const nodeTypeCls = isTool ? "text-cyan-400" : isLLM ? "text-violet-400" : "text-gray-400";

  const editableField = (label: string, attrName: string, value: string | undefined, colorCls = "text-gray-300") => {
    if (!value && !editable) return null;
    if (!value) return null;
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">{label}</div>
        {editable && onAttrChange ? (
          <textarea
            className="w-full whitespace-pre-wrap font-mono text-[11px] text-gray-200 bg-gray-900/80 rounded p-2 border border-gray-700 focus:border-blue-600 focus:outline-none leading-relaxed resize-y min-h-[80px]"
            value={value}
            onChange={(e) => onAttrChange(attrName, e.target.value)}
            rows={Math.max(4, value.split("\n").length + 1)}
          />
        ) : (
          <pre className={`whitespace-pre-wrap font-mono text-[11px] ${colorCls} bg-gray-900/60 rounded p-2 border border-gray-800 leading-relaxed`}>
            {value}
          </pre>
        )}
      </div>
    );
  };

  return (
    <div className="w-96 h-full border-l border-gray-800 flex flex-col shrink-0 bg-gray-900/30">
      {/* Header */}
      <div className="border-b border-gray-800 px-3 py-2 shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-gray-200 truncate font-medium">{nodeLabel}</span>
          <span className={`text-[9px] shrink-0 ${nodeTypeCls}`}>{nodeTypeLabel}</span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-200 text-xs px-2 py-1 rounded hover:bg-gray-800 shrink-0"
        >&#10005;</button>
      </div>

      {/* Save/Revert bar when dirty */}
      {editable && dirty && (
        <div className="border-b border-gray-800/60 px-3 py-1.5 shrink-0 flex items-center gap-2">
          <button
            onClick={onSave}
            disabled={saving}
            className="text-[11px] px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 disabled:cursor-wait"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={onRevert}
            disabled={saving}
            className="text-[11px] px-2 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 disabled:opacity-50"
          >
            Revert
          </button>
          <span className="text-[10px] text-amber-500/80 ml-auto">Unsaved changes</span>
        </div>
      )}

      {/* Attributes */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4 text-xs">
        {editableField("System Prompt", "system_prompt", attrs.systemPrompt)}
        {editableField("Prompt", "prompt", attrs.prompt)}
        {editableField("Tool Command", "tool_command", attrs.toolCommand, "text-cyan-300/80")}

        {/* Context filter (read-only always) */}
        {attrs.contextFilter && (
          <div className="space-y-1">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Context Filter</div>
            <code className="font-mono text-[11px] text-amber-300/70">{attrs.contextFilter}</code>
          </div>
        )}

        {/* Max retry (read-only always) */}
        {attrs.maxRetry && (
          <div className="space-y-1">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Max Retry</div>
            <code className="font-mono text-[11px] text-gray-400">{attrs.maxRetry}</code>
          </div>
        )}

        {/* Fallback when no useful attributes */}
        {!attrs.prompt && !attrs.systemPrompt && !attrs.toolCommand && (
          <div className="text-center space-y-1 pt-8">
            <div className="text-xs text-gray-600">No prompt attributes in DOT graph</div>
            <div className="text-[10px] text-gray-700">Node ID: {nodeId}</div>
          </div>
        )}
      </div>
    </div>
  );
}
