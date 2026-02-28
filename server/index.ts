import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { RunWatcher } from "./runWatcher.js";
import { registerRoutes } from "./routes.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PORT = parseInt(process.env.PORT ?? "3737", 10);

// Resolve the runs directory. Default: ~/.local/state/kilroy/attractor/runs/
const KILROY_RUNS_DIR = resolve(
  process.env.KILROY_RUNS_DIR ??
    join(process.env.HOME ?? "/root", ".local", "state", "kilroy", "attractor", "runs")
);

// Kilroy-dash URL for proxying stage/DOT/diagnosis data.
const KILROY_DASH_URL = process.env.KILROY_DASH_URL ?? "http://localhost:8090";
const KILROY_DASH_TOKEN = process.env.KILROY_DASH_TOKEN ?? "";

// Static files: in production, serve from dist/. In dev, Vite handles the frontend.
const DIST_DIR = resolve(__dirname, "..", "dist");

const app = express();
app.use(express.json());

// Serve Vite build assets
app.use(express.static(DIST_DIR));

const watcher = new RunWatcher(KILROY_RUNS_DIR);

registerRoutes(app, {
  runsDir: KILROY_RUNS_DIR,
  distDir: DIST_DIR,
  kilroyDashUrl: KILROY_DASH_URL,
  kilroyDashToken: KILROY_DASH_TOKEN,
  watcher,
});

const server = app.listen(PORT, () => {
  console.log(`[kilroy-run-pane] Listening on http://localhost:${PORT}`);
  console.log(`[kilroy-run-pane] Runs dir: ${KILROY_RUNS_DIR}`);
  console.log(`[kilroy-run-pane] Kilroy-dash proxy: ${KILROY_DASH_URL}`);
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
