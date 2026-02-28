import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { RunWatcher } from "./runWatcher.js";

const SSE_PING_INTERVAL_MS = 15_000;

export function registerRoutes(
  app: Express,
  opts: {
    runsDirs: string[];
    distDir: string;
    kilroyDashUrl: string;
    kilroyDashToken: string;
    watcher: RunWatcher;
  }
) {
  const { runsDirs, distDir, kilroyDashUrl, kilroyDashToken, watcher } = opts;

  // Proxy all /api/* to kilroy-dash, except the routes we handle ourselves.
  // We handle: /api/runs, /api/runs/:id, /api/runs/:id/events
  // Everything else proxies.
  const proxyHeaders: Record<string, string> = {};
  if (kilroyDashToken) {
    proxyHeaders["Authorization"] = `Bearer ${kilroyDashToken}`;
  }

  const dashProxy = createProxyMiddleware({
    target: kilroyDashUrl,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq) => {
        if (kilroyDashToken) {
          proxyReq.setHeader("Authorization", `Bearer ${kilroyDashToken}`);
        }
      },
    },
  });

  /** Collect all run IDs across all configured runsDirs, deduped, newest-first. */
  async function listAllRunIds(): Promise<{ id: string; runsDir: string }[]> {
    const seen = new Set<string>();
    const results: { id: string; runsDir: string }[] = [];
    for (const dir of runsDirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !seen.has(e.name)) {
            seen.add(e.name);
            results.push({ id: e.name, runsDir: dir });
          }
        }
      } catch { /* dir may not exist */ }
    }
    // Sort by ULID (lexicographic = chronological), newest first
    results.sort((a, b) => b.id.localeCompare(a.id));
    return results;
  }

  // List all run IDs
  app.get("/api/runs", async (_req: Request, res: Response) => {
    const all = await listAllRunIds();
    res.json({ run_ids: all.map((r) => r.id) });
  });

  // Run list with metadata summaries (reads manifest.json per run)
  app.get("/api/runs/summaries", async (_req: Request, res: Response) => {
    const all = await listAllRunIds();
    const summaries = await Promise.all(all.map(async ({ id, runsDir: dir }) => {
      try {
        const runDir = join(dir, id);
        // Try manifest.json (attractor format) first, then run.json (kilroy-dash format)
        let graph_name: string | null = null;
        let repo: string | null = null;
        let goal: string | null = null;
        let started_at: string | null = null;
        let status = "running";

        try {
          const manifestRaw = await readFile(join(runDir, "manifest.json"), "utf8");
          const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
          graph_name = String(manifest.graph_name ?? "");
          const repoPath = String(manifest.repo_path ?? "");
          repo = repoPath ? repoPath.split("/").pop() ?? null : null;
          const goalStr = String(manifest.goal ?? "");
          goal = goalStr ? goalStr.slice(0, 200) : null;
          started_at = typeof manifest.started_at === "string" ? manifest.started_at : null;
        } catch {
          // Try kilroy-dash run.json
          try {
            const runRaw = await readFile(join(runDir, "run.json"), "utf8");
            const run = JSON.parse(runRaw) as Record<string, unknown>;
            graph_name = String(run.dot_file ?? "");
            const repoPath = String(run.repo ?? "");
            repo = repoPath ? repoPath.split("/").pop() ?? null : null;
            started_at = typeof run.started_at === "string" ? run.started_at : null;
          } catch { /* skip */ }
        }

        // First timestamp from progress.ndjson if started_at not in manifest
        if (!started_at) {
          try {
            const progressRaw = await readFile(join(runDir, "progress.ndjson"), "utf8");
            const firstLine = progressRaw.split("\n").find((l) => l.trim());
            if (firstLine) {
              const ev = JSON.parse(firstLine) as Record<string, unknown>;
              started_at = String(ev.ts ?? ev.timestamp ?? "");
            }
          } catch { /* ok */ }
        }

        // Status from final.json, live.json, or run.json
        try {
          const finalRaw = await readFile(join(runDir, "final.json"), "utf8");
          const final = JSON.parse(finalRaw) as Record<string, unknown>;
          const s = String(final.status ?? "");
          status = s === "success" ? "completed" : s === "fail" ? "failed" : "running";
        } catch {
          try {
            const liveRaw = await readFile(join(runDir, "live.json"), "utf8");
            const live = JSON.parse(liveRaw) as Record<string, unknown>;
            if (live.event === "completed") status = "completed";
            else if (live.event === "failed") status = "failed";
            else if (live.event === "interrupted") status = "interrupted";
          } catch { /* ok */ }
        }

        return { id, graph_name, repo, goal, started_at: started_at || null, status, source_dir: dir };
      } catch {
        return { id, graph_name: null, repo: null, goal: null, started_at: null, status: "unknown", source_dir: dir };
      }
    }));
    // Sort by started_at descending if available, otherwise leave ULID order
    summaries.sort((a, b) => {
      if (a.started_at && b.started_at) return b.started_at.localeCompare(a.started_at);
      return b.id.localeCompare(a.id);
    });
    res.json({ runs: summaries });
  });

  // Get current run state snapshot
  app.get("/api/runs/:id", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const state = await watcher.watch(id);
    if (!state) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json(state);
  });

  // SSE stream for live run state updates
  app.get("/api/runs/:id/events", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Ensure watcher is active for this run
    const initialState = await watcher.watch(id);

    // Send initial snapshot
    if (initialState) {
      res.write(`data: ${JSON.stringify(initialState)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: "run not found" })}\n\n`);
    }

    // Subscribe to updates
    const onUpdate = (runId: string, state: unknown) => {
      if (runId !== id) return;
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    };

    watcher.on("update", onUpdate);

    // Keepalive ping
    const ping = setInterval(() => {
      res.write(": ping\n\n");
    }, SSE_PING_INTERVAL_MS);

    // Cleanup on disconnect
    req.on("close", () => {
      clearInterval(ping);
      watcher.off("update", onUpdate);
    });
  });

  // Stage metadata: status.json + file list (attractor format).
  // :node can include slashes for parallel branch stages (e.g. "parallel/dod_fanout/01-dod_a/dod_a").
  app.get("/api/runs/:id/stages/*", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    // Express 4 wildcard captures as req.params[0]
    const rest = String((req.params as Record<string, string>)[0] ?? "");
    // Reject path traversal; allow slashes for branch paths
    if (rest.includes("..") || rest.startsWith("/")) { res.status(400).json({ error: "invalid node" }); return; }

    // Resolve which dir contains this run
    const runDir = await watcher.findRunDir(id);
    if (!runDir) { res.status(404).json({ error: "run not found" }); return; }

    const parts = rest.split("/");
    const lastPart = parts[parts.length - 1];

    // /turns endpoint: parse events.ndjson into structured conversation turns
    if (lastPart === "turns" && parts.length >= 2) {
      const node = parts.slice(0, -1).join("/");
      const eventsPath = join(runDir, node, "events.ndjson");
      try {
        const raw = await readFile(eventsPath, "utf8");
        const turns = parseEventsTurns(raw);
        // Attach final response text from response.md when provider doesn't stream text into events
        try {
          const responseText = await readFile(join(runDir, node, "response.md"), "utf8");
          if (responseText.trim()) turns.response_text = responseText;
        } catch { /* response.md may not exist for tool nodes */ }
        // Attach pricing estimate
        turns.pricing = await computePricing(runDir, node, turns);
        res.json(turns);
      } catch {
        res.status(404).json({ error: "events not found" });
      }
      return;
    }

    // Last segment is the file name if the second-to-last is a known stage dir;
    // to disambiguate "stages/<node>" vs "stages/<node>/<file>" we try the file
    // route first (if rest contains a "/" and the last segment looks like a file).
    const isFileFetch = parts.length >= 2 && lastPart.includes(".");

    if (isFileFetch) {
      const node = parts.slice(0, -1).join("/");
      const file = lastPart;
      if (file.includes("..")) { res.status(400).json({ error: "invalid path" }); return; }
      const filePath = join(runDir, node, file);
      try {
        await stat(filePath);
        res.sendFile(filePath);
      } catch {
        res.status(404).json({ error: "file not found" });
      }
      return;
    }

    // Metadata fetch
    const node = rest;
    const stageDir = join(runDir, node);
    try {
      let statusData: Record<string, unknown> = {};
      try {
        const raw = await readFile(join(stageDir, "status.json"), "utf8");
        statusData = JSON.parse(raw);
      } catch { /* no status yet */ }
      const entries = await readdir(stageDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((n) => !n.endsWith(".tgz"));
      res.json({ node_id: node, ...statusData, files });
    } catch {
      res.status(404).json({ error: "stage not found" });
    }
  });

  // Proxy all other /api/* requests to kilroy-dash
  app.use("/api", (req: Request, res: Response, next) => {
    // Skip routes we handle above
    if (req.path === "/runs" && req.method === "GET") return next("route");
    if (req.path === "/runs/summaries" && req.method === "GET") return next("route");
    if (req.path.match(/^\/runs\/[^/]+$/) && req.method === "GET") return next("route");
    if (req.path.match(/^\/runs\/[^/]+\/events$/) && req.method === "GET") return next("route");
    if (req.path.match(/^\/runs\/[^/]+\/stages\//) && req.method === "GET") return next("route");
    return dashProxy(req, res, next);
  });

  // Serve SPA for /run/* routes (must come after API routes)
  app.get("/run/*", (_req: Request, res: Response) => {
    res.sendFile(join(distDir, "index.html"));
  });

  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(join(distDir, "index.html"));
  });
}

// ── Turn parsing ────────────────────────────────────────────────────────────

interface ToolCallRecord {
  call_id: string;
  tool_name: string;
  arguments: unknown;
  output: string;
  is_error: boolean;
}

interface AssistantStep {
  text?: string;
  tool_call?: ToolCallRecord;
}

interface TurnUser {
  role: "user";
  text: string;
}

interface TurnAssistant {
  role: "assistant";
  steps: AssistantStep[];
}

interface PricingEstimate {
  model_id: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number | null;
  prompt_price_per_token: number | null;
  completion_price_per_token: number | null;
}

interface TurnsResponse {
  session_id?: string;
  model?: string;
  profile?: string;
  turns: (TurnUser | TurnAssistant)[];
  pricing?: PricingEstimate;
  response_text?: string;
}

function parseEventsTurns(raw: string): TurnsResponse {
  const events: Array<{ kind: string; session_id?: string; data?: Record<string, unknown> }> = [];
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try { events.push(JSON.parse(l)); } catch { /* skip malformed */ }
  }

  let session_id: string | undefined;
  let model: string | undefined;
  let profile: string | undefined;

  const turns: (TurnUser | TurnAssistant)[] = [];
  const assistantSteps: AssistantStep[] = [];
  const pendingCalls = new Map<string, { tool_name: string; arguments: unknown }>();

  const flushAssistant = () => {
    if (assistantSteps.length > 0) {
      turns.push({ role: "assistant", steps: [...assistantSteps] });
      assistantSteps.length = 0;
    }
  };

  for (const ev of events) {
    const d = ev.data ?? {};
    switch (ev.kind) {
      case "SESSION_START":
        session_id = ev.session_id;
        model = String(d.model ?? "");
        profile = String(d.profile ?? "");
        break;
      case "USER_INPUT":
        flushAssistant();
        turns.push({ role: "user", text: String(d.text ?? "") });
        break;
      case "TOOL_CALL_START": {
        let args: unknown;
        try { args = JSON.parse(String(d.arguments_json ?? "{}")); } catch { args = d.arguments_json; }
        pendingCalls.set(String(d.call_id), { tool_name: String(d.tool_name ?? ""), arguments: args });
        break;
      }
      case "TOOL_CALL_END": {
        const callId = String(d.call_id ?? "");
        const pending = pendingCalls.get(callId);
        if (pending) {
          assistantSteps.push({
            tool_call: {
              call_id: callId,
              tool_name: String(d.tool_name ?? pending.tool_name),
              arguments: pending.arguments,
              output: String(d.full_output ?? ""),
              is_error: Boolean(d.is_error),
            },
          });
          pendingCalls.delete(callId);
        }
        break;
      }
      case "ASSISTANT_TEXT_END": {
        const text = String(d.text ?? "");
        if (text) assistantSteps.push({ text });
        break;
      }
    }
  }

  flushAssistant();
  return { session_id, model: model || undefined, profile: profile || undefined, turns };
}

async function computePricing(
  runDir: string,
  node: string,
  turnsData: TurnsResponse,
): Promise<PricingEstimate | undefined> {
  try {
    // Model from events or provider_used.json
    let modelId = turnsData.model ?? "";
    const profile = turnsData.profile ?? "";
    try {
      const pvRaw = await readFile(join(runDir, node, "provider_used.json"), "utf8");
      const pv = JSON.parse(pvRaw) as Record<string, unknown>;
      if (pv.model) modelId = String(pv.model);
    } catch { /* ok */ }

    if (!modelId) return undefined;

    // Estimate token counts from text lengths
    let inputChars = 0;
    let outputChars = 0;
    for (const turn of turnsData.turns) {
      if (turn.role === "user") {
        inputChars += turn.text.length;
      } else {
        for (const step of turn.steps) {
          if (step.text) outputChars += step.text.length;
          // Tool outputs feed back as input context (rough estimate)
          if (step.tool_call) inputChars += step.tool_call.output.length * 0.5;
        }
      }
    }
    const estimatedInputTokens = Math.round(inputChars / 4);
    const estimatedOutputTokens = Math.round(outputChars / 4);

    // Look up pricing from modeldb
    const lookupKey = profile ? `${profile}/${modelId}` : modelId;
    let promptPrice: number | null = null;
    let completionPrice: number | null = null;
    try {
      const manifestRaw = await readFile(join(runDir, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      const modeldbObj = manifest.modeldb as Record<string, unknown> | undefined;
      const modelInfoPath = modeldbObj?.openrouter_model_info_path as string | undefined;
      if (modelInfoPath) {
        const modeldbRaw = await readFile(modelInfoPath, "utf8");
        const modeldb = JSON.parse(modeldbRaw) as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
        const entry = modeldb.data?.find(
          (m) => m.id === lookupKey || m.id.endsWith(`/${modelId}`) || m.id === modelId
        );
        if (entry?.pricing) {
          promptPrice = entry.pricing.prompt ? parseFloat(entry.pricing.prompt) : null;
          completionPrice = entry.pricing.completion ? parseFloat(entry.pricing.completion) : null;
        }
      }
    } catch { /* modeldb not available */ }

    const estimatedCost =
      promptPrice !== null && completionPrice !== null
        ? estimatedInputTokens * promptPrice + estimatedOutputTokens * completionPrice
        : null;

    return {
      model_id: lookupKey,
      estimated_input_tokens: estimatedInputTokens,
      estimated_output_tokens: estimatedOutputTokens,
      estimated_cost_usd: estimatedCost,
      prompt_price_per_token: promptPrice,
      completion_price_per_token: completionPrice,
    };
  } catch {
    return undefined;
  }
}
