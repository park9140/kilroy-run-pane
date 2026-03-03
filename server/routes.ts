import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import archiver from "archiver";
import type { Express, Request, Response } from "express";
import type { RunWatcher } from "./runWatcher.js";

const SSE_PING_INTERVAL_MS = 15_000;

export function registerRoutes(
  app: Express,
  opts: {
    runsDirs: string[];
    distDir: string;
    watcher: RunWatcher;
  }
) {
  const { runsDirs, distDir, watcher } = opts;

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

        let repo_path: string | null = null;
        try {
          const manifestRaw = await readFile(join(runDir, "manifest.json"), "utf8");
          const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
          graph_name = String(manifest.graph_name ?? "");
          const repoPath = String(manifest.repo_path ?? "");
          repo_path = repoPath || null;
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
            repo_path = repoPath || null;
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

        return { id, graph_name, repo, repo_path, goal, started_at: started_at || null, status, source_dir: dir };
      } catch {
        return { id, graph_name: null, repo: null, repo_path: null, goal: null, started_at: null, status: "unknown", source_dir: dir };
      }
    }));
    // Sort by started_at descending if available, otherwise leave ULID order
    summaries.sort((a, b) => {
      if (a.started_at && b.started_at) return b.started_at.localeCompare(a.started_at);
      return b.id.localeCompare(a.id);
    });
    res.json({ runs: summaries });
  });

  // Get current run state snapshot (one-time read, no watcher created)
  app.get("/api/runs/:id", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const state = await watcher.readOnce(id);
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

    // Cleanup on disconnect — tear down watcher when last SSE client leaves
    req.on("close", () => {
      clearInterval(ping);
      watcher.off("update", onUpdate);
      watcher.sseDisconnect(id);
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
        // Attach final response text from response.md when the parser didn't produce one.
        // Skip if we already have response_text (e.g. Codex format embeds it in events),
        // and skip if response.md looks like raw NDJSON (starts with '{').
        if (!turns.response_text) {
          try {
            const responseText = await readFile(join(runDir, node, "response.md"), "utf8");
            const trimmed = responseText.trim();
            if (trimmed && !trimmed.startsWith("{")) turns.response_text = trimmed;
          } catch { /* response.md may not exist for tool nodes */ }
        }
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

  // Workspace: list commits for this run, oldest-first
  app.get("/api/runs/:id/workspace/commits", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }
    const { execFile } = await import("node:child_process");
    execFile(
      "git", ["log", "--all", "--topo-order", "--pretty=format:%H %s"],
      { cwd: worktreePath, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) { res.status(500).json({ error: String(err) }); return; }
        const prefix = `attractor(${id}): `;
        const commits: { sha: string; node_id: string; status: string }[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          const spaceIdx = line.indexOf(" ");
          if (spaceIdx < 0) continue;
          const sha = line.slice(0, spaceIdx);
          const subject = line.slice(spaceIdx + 1);
          if (!subject.startsWith(prefix)) continue;
          const rest = subject.slice(prefix.length);
          const m = /^(.+) \((.+)\)$/.exec(rest);
          if (!m) continue;
          commits.push({ sha, node_id: m[1], status: m[2] });
        }
        commits.reverse(); // oldest-first
        res.json(commits);
      }
    );
  });

  // Workspace: list parallel branch refs and their tip SHAs for this run
  app.get("/api/runs/:id/workspace/branches", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }
    const { execFile } = await import("node:child_process");
    const prefix = `refs/heads/attractor/run/parallel/${id}/`;
    execFile(
      "git", ["for-each-ref", "--format=%(refname:short) %(objectname)", prefix],
      { cwd: worktreePath, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) { res.status(500).json({ error: String(err) }); return; }
        const branches: { name: string; sha: string }[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          const spaceIdx = line.lastIndexOf(" ");
          if (spaceIdx < 0) continue;
          branches.push({ name: line.slice(0, spaceIdx), sha: line.slice(spaceIdx + 1) });
        }
        res.json(branches);
      }
    );
  });

  // Workspace: list files in the worktree (or at a specific git ref)
  app.get("/api/runs/:id/workspace", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const ref = String(req.query["ref"] ?? "");
    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }

    // When a git ref is supplied, list files from the commit tree
    if (ref) {
      if (!/^[0-9a-f]{6,40}\^?$/i.test(ref)) { res.status(400).json({ error: "invalid ref" }); return; }
      const { execFile } = await import("node:child_process");
      execFile(
        "git", ["ls-tree", "-r", "-l", ref],
        { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) { res.status(500).json({ error: String(err) }); return; }
          type WorkspaceFile = { path: string; name: string; size: number; mtime: number };
          const files: WorkspaceFile[] = [];
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            // Format: <mode> <type> <sha>    <size>\t<path>
            const tabIdx = line.indexOf("\t");
            if (tabIdx < 0) continue;
            const filePath = line.slice(tabIdx + 1).trim();
            const meta = line.slice(0, tabIdx).trim().split(/\s+/);
            const size = meta[3] ? parseInt(meta[3], 10) : 0;
            const name = filePath.split("/").pop() ?? filePath;
            files.push({ path: filePath, name, size: isNaN(size) ? 0 : size, mtime: 0 });
          }
          files.sort((a, b) => a.path.localeCompare(b.path));
          res.json({ files, worktreePath });
        }
      );
      return;
    }

    // Skip .git regardless of whether it's a file or dir (git worktrees use a .git file)
    const SKIP = new Set([".git", "node_modules"]);
    type WorkspaceFile = { path: string; name: string; size: number; mtime: number };
    const files: WorkspaceFile[] = [];

    async function scanDir(dir: string, prefix: string) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        // Parallel stat calls — much faster than sequential for large repos
        await Promise.all(entries.map(async (e) => {
          if (SKIP.has(e.name)) return;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            await scanDir(join(dir, e.name), rel);
          } else if (e.isFile()) {
            try {
              const s = await stat(join(dir, e.name));
              files.push({ path: rel, name: e.name, size: s.size, mtime: s.mtimeMs });
            } catch { /* skip */ }
          }
        }));
      } catch { /* dir missing */ }
    }

    await scanDir(worktreePath, "");
    files.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ files, worktreePath });
  });

  // Workspace: serve a single file by relative path (or at a specific git ref)
  app.get("/api/runs/:id/workspace/file", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const relPath = String(req.query["path"] ?? "");
    const ref = String(req.query["ref"] ?? "");
    if (!relPath || relPath.includes("..")) { res.status(400).json({ error: "invalid path" }); return; }

    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }

    if (ref) {
      if (!/^[0-9a-f]{6,40}\^?$/i.test(ref)) { res.status(400).json({ error: "invalid ref" }); return; }
      const { execFile } = await import("node:child_process");
      execFile(
        "git", ["show", `${ref}:${relPath}`],
        { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" } as Parameters<typeof execFile>[2],
        (err, stdout, stderr) => {
          if (err) { res.status(404).json({ error: (stderr as string) || "not found" }); return; }
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.send(stdout);
        }
      );
      return;
    }

    const absPath = join(worktreePath, relPath);
    // Ensure path stays within worktree
    if (!absPath.startsWith(worktreePath + "/") && absPath !== worktreePath) {
      res.status(400).json({ error: "path outside worktree" }); return;
    }
    try {
      const content = await readFile(absPath, "utf8");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(content);
    } catch {
      res.status(404).json({ error: "file not found" });
    }
  });

  // Workspace: download all .ai/ files as a zip
  app.get("/api/runs/:id/workspace/download", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="workspace-${id.slice(-8)}.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => { res.destroy(err); });
    archive.pipe(res);
    archive.glob("**", { cwd: worktreePath, ignore: [".git", ".git/**", "node_modules", "node_modules/**"], dot: true });
    await archive.finalize();
  });

  // Workspace: git diff HEAD in the worktree
  app.get("/api/runs/:id/workspace/diff", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }
    const { execFile } = await import("node:child_process");
    execFile(
      "git", ["diff", "HEAD"],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // git exits 1 when there are differences — that's normal, not an error
        if (err && !stdout) {
          res.status(500).json({ error: stderr || String(err) }); return;
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(stdout);
      }
    );
  });

  // Workspace: diff introduced by a specific commit (git diff PARENT..SHA)
  // Optional ?from=<sha> for range diffs (git diff FROM..REF) instead of single-commit diffs.
  app.get("/api/runs/:id/workspace/commit-diff", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const ref = String(req.query["ref"] ?? "");
    const from = String(req.query["from"] ?? "");
    if (!ref || !/^[0-9a-f]{6,40}$/i.test(ref)) { res.status(400).json({ error: "invalid ref" }); return; }
    if (from && !/^[0-9a-f]{6,40}$/i.test(from)) { res.status(400).json({ error: "invalid from" }); return; }
    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }
    const { execFile } = await import("node:child_process");
    // When from is provided: git diff FROM..REF (range diff for branch work)
    // Otherwise: git diff PARENT..SHA; fall back to git show --format="" for root commit
    const diffRange = from ? `${from}..${ref}` : `${ref}^..${ref}`;
    execFile(
      "git", ["diff", diffRange],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          if (from) { res.status(500).json({ error: String(stderr) || String(err) }); return; }
          execFile(
            "git", ["show", "--format=", ref],
            { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
            (err2, stdout2, stderr2) => {
              if (err2 && !stdout2) { res.status(500).json({ error: String(stderr2) || String(err2) }); return; }
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.send(stdout2);
            }
          );
          return;
        }
        void stderr;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(stdout);
      }
    );
  });

  // Workspace: reveal worktree in the OS file manager (macOS, Windows, Linux)
  app.post("/api/runs/:id/workspace/reveal", async (req: Request, res: Response) => {
    const id = String(req.params["id"] ?? "");
    const state = watcher.getState(id) ?? await watcher.readOnce(id);
    const worktreePath = state?.worktreePath;
    if (!worktreePath) { res.status(404).json({ error: "no worktree" }); return; }
    const { execFile } = await import("node:child_process");
    const [cmd, args]: [string, string[]] =
      process.platform === "win32"  ? ["explorer", [worktreePath]] :
      process.platform === "darwin" ? ["open",     [worktreePath]] :
                                      ["xdg-open", [worktreePath]];
    execFile(cmd, args, (err) => {
      if (err) { res.status(500).json({ error: String(err) }); return; }
      res.json({ ok: true });
    });
  });

  // Read a local .dot/.gv file by absolute path (used for VS Code drag-and-drop)
  app.get("/api/local-file", async (req: Request, res: Response) => {
    const filePath = String(req.query["path"] ?? "");
    if (!filePath || filePath.includes("..")) { res.status(400).json({ error: "invalid path" }); return; }
    if (!filePath.endsWith(".dot") && !filePath.endsWith(".gv")) {
      res.status(400).json({ error: "only .dot/.gv files supported" }); return;
    }
    try {
      const content = await readFile(filePath, "utf8");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(content);
    } catch {
      res.status(404).json({ error: "file not found" });
    }
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
  thinking?: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = [];
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try { events.push(JSON.parse(l)); } catch { /* skip malformed */ }
  }

  // Fingerprint by first event:
  //   Kilroy format   → { kind: "SESSION_START", ... }
  //   Claude Code     → { type: "system", ... }
  //   Codex           → { type: "thread.started", ... }
  const firstEv = events[0];
  if (firstEv?.kind) return parseKilroyEvents(events);
  if (firstEv?.type === "thread.started") return parseCodexEvents(events);
  return parseClaudeCodeEvents(events);
}

// ── Kilroy format parser (kind: SESSION_START / USER_INPUT / TOOL_CALL_* / ASSISTANT_TEXT_END)

function parseKilroyEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any[],
): TurnsResponse {
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

// ── Claude Code native format parser (type: system / assistant / user / result)
// Each assistant event has a message.id — events with the same id belong to one turn.
// Content blocks: thinking, text, tool_use. Tool results arrive in subsequent user events.

function parseClaudeCodeEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any[],
): TurnsResponse {
  let session_id: string | undefined;
  let model: string | undefined;
  let response_text: string | undefined;

  const turns: (TurnUser | TurnAssistant)[] = [];
  let currentMsgId: string | undefined;
  const currentSteps: AssistantStep[] = [];

  const flushAssistant = () => {
    if (currentSteps.length > 0) {
      turns.push({ role: "assistant", steps: [...currentSteps] });
      currentSteps.length = 0;
    }
    currentMsgId = undefined;
  };

  for (const ev of events) {
    const evType = ev.type;

    if (evType === "system") {
      session_id = ev.session_id;
      model = ev.model;
    } else if (evType === "assistant") {
      const msg = ev.message;
      const msgId: string | undefined = msg?.id;
      if (!msgId) continue;

      if (currentMsgId && currentMsgId !== msgId) {
        flushAssistant();
      }
      currentMsgId = msgId;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const block of (msg.content ?? []) as any[]) {
        if (block.type === "thinking" && block.thinking) {
          currentSteps.push({ thinking: String(block.thinking) });
        } else if (block.type === "text" && block.text) {
          currentSteps.push({ text: String(block.text) });
        } else if (block.type === "tool_use") {
          currentSteps.push({
            tool_call: {
              call_id: String(block.id ?? ""),
              tool_name: String(block.name ?? ""),
              arguments: (block.input ?? {}) as Record<string, unknown>,
              output: "",
              is_error: false,
            },
          });
        }
      }
    } else if (evType === "user") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const block of (ev.message?.content ?? []) as any[]) {
        if (block.type === "tool_result") {
          const toolId = String(block.tool_use_id ?? "");
          const step = currentSteps.find((s) => s.tool_call?.call_id === toolId);
          if (step?.tool_call) {
            const raw = block.content;
            step.tool_call.output = typeof raw === "string"
              ? raw
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              : Array.isArray(raw) ? (raw as any[]).map((c) => (typeof c === "string" ? c : (c.text ?? JSON.stringify(c)))).join("") : JSON.stringify(raw);
            step.tool_call.is_error = Boolean(block.is_error);
          }
        }
      }
    } else if (evType === "result" && ev.result) {
      response_text = String(ev.result);
    }
  }

  flushAssistant();
  return { session_id, model: model || undefined, turns, response_text };
}

// ── Codex format parser (type: thread.started / item.started / item.completed / turn.*)
// Items: reasoning (thinking), command_execution (shell), file_change, agent_message (final text)

function parseCodexEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any[],
): TurnsResponse {
  const steps: AssistantStep[] = [];
  let response_text: string | undefined;

  for (const ev of events) {
    if (ev.type !== "item.completed") continue;
    const item = ev.item;
    if (!item) continue;

    switch (item.type) {
      case "reasoning":
        if (item.text) steps.push({ thinking: String(item.text) });
        break;
      case "command_execution":
        steps.push({
          tool_call: {
            call_id: String(item.id ?? ""),
            tool_name: "command_execution",
            arguments: { command: String(item.command ?? "") },
            output: String(item.aggregated_output ?? ""),
            is_error: typeof item.exit_code === "number" && item.exit_code !== 0,
          },
        });
        break;
      case "file_change": {
        const changes: Array<{ path?: string; kind?: string }> =
          Array.isArray(item.changes) ? item.changes : [];
        const changesText = changes.map((c) => `${c.kind ?? "?"}: ${c.path ?? ""}`).join("\n");
        steps.push({
          tool_call: {
            call_id: String(item.id ?? ""),
            tool_name: "file_change",
            arguments: { changes },
            output: changesText,
            is_error: false,
          },
        });
        break;
      }
      case "agent_message": {
        // agent_message.text may be JSON: { final: "...", summary: "..." }
        let text = String(item.text ?? "");
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed.final === "string") text = parsed.final;
        } catch { /* plain text */ }
        response_text = text;
        if (text) steps.push({ text });
        break;
      }
    }
  }

  return {
    turns: steps.length > 0 ? [{ role: "assistant", steps }] : [],
    response_text,
  };
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
