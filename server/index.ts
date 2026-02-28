import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { RunWatcher } from "./runWatcher.js";
import { registerRoutes } from "./routes.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PORT = parseInt(process.env.PORT ?? "3737", 10);

// Resolve one or more runs directories.
// KILROY_RUNS_DIRS: colon-separated list (takes precedence)
// KILROY_RUNS_DIR: single dir (legacy, still supported)
// Default: ~/.local/state/kilroy/attractor/runs/
function resolveRunsDirs(): string[] {
  if (process.env.KILROY_RUNS_DIRS) {
    return process.env.KILROY_RUNS_DIRS.split(":").map((d) => resolve(d)).filter(Boolean);
  }
  return [
    resolve(
      process.env.KILROY_RUNS_DIR ??
        join(process.env.HOME ?? "/root", ".local", "state", "kilroy", "attractor", "runs")
    ),
  ];
}

const KILROY_RUNS_DIRS = resolveRunsDirs();

// Static files: in production, serve from dist/. In dev, Vite handles the frontend.
const DIST_DIR = resolve(__dirname, "..", "dist");

const app = express();
app.use(express.json());

// Serve Vite build assets
app.use(express.static(DIST_DIR));

const watcher = new RunWatcher(KILROY_RUNS_DIRS);

registerRoutes(app, {
  runsDirs: KILROY_RUNS_DIRS,
  distDir: DIST_DIR,
  watcher,
});

const server = app.listen(PORT, () => {
  console.log(`[kilroy-run-pane] Listening on http://localhost:${PORT}`);
  console.log(`[kilroy-run-pane] Runs dirs:`);
  for (const d of KILROY_RUNS_DIRS) console.log(`[kilroy-run-pane]   - ${d}`);
});

process.on("SIGTERM", () => {
  watcher.close();
  server.close();
});

process.on("SIGINT", () => {
  watcher.close();
  server.close();
  process.exit(0);
});
