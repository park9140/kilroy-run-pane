export type RunStatus = "pending" | "executing" | "completed" | "failed" | "stopped" | "interrupted";
export type ComputedStatus = "executing" | "stalled" | "completed" | "failed" | "interrupted" | "unknown";

export interface RunAnnotation {
  id: string;
  kind: "report" | "review";
  title: string;
  icon?: string;
  sidebar_target?: string;
  artifact_path?: string;
  node?: string;
  timestamp?: string;
  source?: string;
  run_id?: string;
}

export interface RunRecord {
  id: string;
  repo?: string;
  dot_file?: string;
  status?: RunStatus;
  current_node?: string;
  container_id?: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  last_heartbeat?: string;
  failure_reason?: string;
  attractor_run_id?: string;
  attractor_logs_root?: string;
  has_checkpoint?: boolean;
  params?: Record<string, string>;
  artifacts?: string[];
  annotations?: RunAnnotation[];
  notifications?: unknown[];
  notes?: unknown[];
  source?: string;
  service?: string;
  parent_run_id?: string;
  restart_index?: number;
}

export interface VisitedStage {
  node_id: string;
  attempt: number;
  status: "pass" | "fail" | "running";
  started_at: string;
  finished_at?: string;
  duration_s?: number;
  failure_reason?: string;
  // Set for parallel branch stages
  fan_out_node?: string;
  branch_key?: string;
  // Relative path from runsDir for branch stages (e.g. "parallel/dod_fanout/01-dod_a/dod_a")
  stage_path?: string;
  // 0 = root run, 1 = restart-1, N = restart-N
  restartIndex?: number;
}

export interface CycleInfo {
  failingNodeId: string;
  retryTargetNodeId?: string;
  signature: string;
  signatureCount: number;
  signatureLimit: number;
  isBreaker: boolean;
}

export interface RunState {
  run: RunRecord;
  containerAlive: boolean;
  computedStatus: ComputedStatus;
  lastChecked: string;
  dot?: string;
  stages?: StageInfo[];
  stageHistory?: VisitedStage[];
  cycleInfo?: CycleInfo;
  restartCount?: number;
  format?: string;
}

export interface StageFileInfo {
  name: string;
  size: number;
  mime?: string;
  kind?: string;
}

export interface StageInfo {
  node_id: string;
  status: string;
  started_at?: string;
  finished_at?: string;
  failure_reason?: string;
  attempt?: number;
  output_files?: StageFileInfo[];
  context_updates?: Record<string, unknown>;
  notes?: string;
  children?: StageInfo[];
  stage_dir?: string;
}

export interface DiagnosisResult {
  run_id: string;
  summary: string;
  severity: "critical" | "warning" | "info";
  stages?: StageInfo[];
  issues?: unknown[];
}

export interface DotResponse {
  dot: string;
}

// ── LLM Turn types ────────────────────────────────────────────────────────

export interface ToolCallRecord {
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  output: string;
  is_error: boolean;
}

export interface AssistantStep {
  text?: string;
  tool_call?: ToolCallRecord;
}

export interface TurnUser {
  role: "user";
  text: string;
}

export interface TurnAssistant {
  role: "assistant";
  steps: AssistantStep[];
}

export type Turn = TurnUser | TurnAssistant;

export interface PricingEstimate {
  model_id: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number | null;
  prompt_price_per_token: number | null;
  completion_price_per_token: number | null;
}

export interface TurnsData {
  session_id?: string;
  model?: string;
  profile?: string;
  turns: Turn[];
  pricing?: PricingEstimate;
  /** Final LLM response text from response.md (may not appear in event stream for some providers) */
  response_text?: string;
}
