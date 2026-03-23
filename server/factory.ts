import type { Express, Request, Response } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repairCheckpointForResume } from "./checkpointRepair.js";

type FactoryOpts = {
  runsDirs: string[];
  projectRoot: string;
};

function requireFactoryAuth(req: Request, res: Response): boolean {
  const want = process.env.KILROY_FACTORY_TOKEN?.trim() ?? "";
  if (!want) {
    res.status(503).json({ error: "factory API disabled (no KILROY_FACTORY_TOKEN)" });
    return false;
  }
  const h = String(req.headers.authorization ?? "");
  const prefix = "Bearer ";
  if (!h.startsWith(prefix) || h.slice(prefix.length).trim() !== want) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function primaryRunsDir(runsDirs: string[]): string {
  return runsDirs[0] ?? join(process.env.HOME ?? "/root", ".local", "state", "kilroy", "attractor", "runs");
}

let active: ChildProcess | null = null;
let lastFactoryError = "";

function setActive(child: ChildProcess | null) {
  active = child;
}

export function registerFactoryRoutes(app: Express, opts: FactoryOpts) {
  const { runsDirs, projectRoot } = opts;
  const runsRoot = primaryRunsDir(runsDirs);

  app.get("/api/factory/attractor/status", (req: Request, res: Response) => {
    if (!requireFactoryAuth(req, res)) return;
    res.json({
      busy: active !== null,
      pid: active?.pid ?? null,
      last_error: lastFactoryError || null,
      runs_root: runsRoot,
    });
  });

  app.post("/api/factory/attractor/start", async (req: Request, res: Response) => {
    if (!requireFactoryAuth(req, res)) return;
    if (active) {
      res.status(409).json({ error: "attractor already running in this container" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const graphPath = String(body.graph_path ?? "").trim();
    const composeFile = String(body.compose_file ?? process.env.KILROY_DEFAULT_COMPOSE ?? "run-compose.yaml").trim();
    if (!graphPath) {
      res.status(400).json({ error: "graph_path required" });
      return;
    }
    const absGraph = resolve(graphPath);
    const absProj = resolve(projectRoot);
    if (!absGraph.startsWith(absProj + "/") && absGraph !== absProj) {
      res.status(400).json({ error: "graph_path must be under project root" });
      return;
    }
    try {
      await access(absGraph);
    } catch {
      res.status(400).json({ error: "graph_path not found" });
      return;
    }

    const cwd = absProj;
    const logPath = "/tmp/kilroy-factory-attractor.log";
    const log = createWriteStream(logPath, { flags: "a" });
    const args = [
      "attractor",
      "run",
      "--skip-cli-headless-warning",
      "--graph",
      absGraph,
      "--config",
      composeFile,
    ];
    const child = spawn("kilroy", args, { cwd, env: process.env, stdio: ["ignore", log, log] });
    setActive(child);
    lastFactoryError = "";
    child.on("exit", (code, signal) => {
      setActive(null);
      if (code && code !== 0) {
        lastFactoryError = `attractor exited ${code}`;
      }
      if (signal) {
        lastFactoryError = `attractor signal ${signal}`;
      }
    });
    child.on("error", (err) => {
      setActive(null);
      lastFactoryError = String(err.message ?? err);
    });
    res.json({ status: "started", pid: child.pid, log: logPath });
  });

  app.post("/api/factory/attractor/resume", async (req: Request, res: Response) => {
    if (!requireFactoryAuth(req, res)) return;
    if (active) {
      res.status(409).json({ error: "attractor already running in this container" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const attractorRunId = String(body.attractor_run_id ?? "").trim();
    if (!attractorRunId) {
      res.status(400).json({ error: "attractor_run_id required" });
      return;
    }
    const runDir = join(runsRoot, attractorRunId);
    try {
      await repairCheckpointForResume(runsRoot, attractorRunId);
    } catch (e) {
      lastFactoryError = String(e);
      res.status(500).json({ error: "checkpoint repair failed", detail: lastFactoryError });
      return;
    }
    const logsRoot = runDir;
    const cwd = resolve(projectRoot);
    const logPath = "/tmp/kilroy-factory-attractor.log";
    const log = createWriteStream(logPath, { flags: "a" });
    const args = ["attractor", "resume", "--logs-root", logsRoot];
    const child = spawn("kilroy", args, { cwd, env: process.env, stdio: ["ignore", log, log] });
    setActive(child);
    lastFactoryError = "";
    child.on("exit", (code, signal) => {
      setActive(null);
      if (code && code !== 0) {
        lastFactoryError = `resume exited ${code}`;
      }
      if (signal) {
        lastFactoryError = `resume signal ${signal}`;
      }
    });
    child.on("error", (err) => {
      setActive(null);
      lastFactoryError = String(err.message ?? err);
    });
    res.json({ status: "resumed", pid: child.pid, logs_root: logsRoot, log: logPath });
  });

  app.post("/api/factory/attractor/resume-incomplete", async (req: Request, res: Response) => {
    if (!requireFactoryAuth(req, res)) return;
    if (active) {
      res.json({ status: "skipped", reason: "busy" });
      return;
    }
    let entries: string[] = [];
    try {
      const dirents = await readdir(runsRoot, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      entries = [];
    }
    const resumed: string[] = [];
    for (const id of entries) {
      if (active) break;
      try {
        await access(join(runsRoot, id, "checkpoint.json"));
      } catch {
        continue;
      }
      let needs = false;
      try {
        await access(join(runsRoot, id, "final.json"));
      } catch {
        needs = true;
      }
      if (!needs) {
        try {
          const raw = await readFile(join(runsRoot, id, "final.json"), "utf8");
          const fj = JSON.parse(raw) as Record<string, unknown>;
          const st = String(fj["status"] ?? "");
          if (st === "fail" || st === "work_failed") needs = true;
        } catch {
          needs = true;
        }
      }
      if (!needs) continue;

      try {
        await repairCheckpointForResume(runsRoot, id);
      } catch (e) {
        lastFactoryError = String(e);
        continue;
      }
      const logsRoot = join(runsRoot, id);
      const cwd = resolve(projectRoot);
      const logPath = "/tmp/kilroy-factory-attractor.log";
      const log = createWriteStream(logPath, { flags: "a" });
      const child = spawn("kilroy", ["attractor", "resume", "--logs-root", logsRoot], {
        cwd,
        env: process.env,
        stdio: ["ignore", log, log],
      });
      setActive(child);
      lastFactoryError = "";
      resumed.push(id);
      child.on("exit", () => setActive(null));
      child.on("error", (err) => {
        setActive(null);
        lastFactoryError = String(err.message ?? err);
      });
      break;
    }
    res.json({ status: "ok", resumed });
  });
}
