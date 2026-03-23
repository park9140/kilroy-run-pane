import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * repairCheckpointForResume mirrors kilroy-dash's Go repair logic enough for embedded resume.
 */
export async function repairCheckpointForResume(runsRoot: string, runID: string): Promise<void> {
  const runDir = join(runsRoot, runID);
  const cpPath = join(runDir, "checkpoint.json");
  let data: string;
  try {
    data = await readFile(cpPath, "utf8");
  } catch {
    return;
  }
  let cp: Record<string, unknown>;
  try {
    cp = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  let runFailed = false;
  const ctx = cp["context"] as Record<string, unknown> | undefined;
  if (ctx && ctx["outcome"] === "fail") {
    runFailed = true;
  }
  if (!runFailed) {
    try {
      const finalRaw = await readFile(join(runDir, "final.json"), "utf8");
      const fj = JSON.parse(finalRaw) as Record<string, unknown>;
      const st = String(fj["status"] ?? "");
      if (st === "fail" || st === "work_failed") runFailed = true;
    } catch {
      /* no final */
    }
  }
  if (!runFailed) return;

  let failedNode = "";
  const retries = cp["node_retries"] as Record<string, number> | undefined;
  let maxRetries = 0;
  if (retries) {
    for (const [node, count] of Object.entries(retries)) {
      if (node === "exit" || node === "start") continue;
      const c = typeof count === "number" ? count : Number(count);
      if (c > maxRetries) {
        maxRetries = c;
        failedNode = node;
      }
    }
  }
  if (!failedNode) {
    const completedRaw = cp["completed_nodes"] as unknown[] | undefined;
    const completed = new Set<string>();
    if (completedRaw) {
      for (const n of completedRaw) {
        if (typeof n === "string") completed.add(n);
      }
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(runDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "worktree" || e.name === "modeldb" || e.name === "parallel") continue;
      if (!completed.has(e.name)) {
        failedNode = e.name;
        break;
      }
    }
  }
  if (!failedNode || failedNode === "exit") {
    const cn = String(cp["current_node"] ?? "");
    if (cn && cn !== "exit" && cn !== "start") failedNode = cn;
  }
  if (!failedNode || failedNode === "exit") {
    if (ctx) {
      const pn = String(ctx["previous_node"] ?? "");
      if (pn && pn !== "exit" && pn !== "start") failedNode = pn;
    }
  }
  if (!failedNode || failedNode === "exit") return;

  const completedRaw = (cp["completed_nodes"] as unknown[] | undefined) ?? [];
  const newCompleted: unknown[] = [];
  for (const n of completedRaw) {
    const name = typeof n === "string" ? n : "";
    if (name === failedNode || name === "exit") continue;
    newCompleted.push(n);
  }
  cp["completed_nodes"] = newCompleted;
  cp["current_node"] = failedNode;

  if (ctx) {
    delete ctx["outcome"];
    delete ctx["failure_reason"];
    delete ctx["failure_class"];
    ctx["current_node"] = failedNode;
    const ctxCompleted = ctx["completed_nodes"] as unknown[] | undefined;
    if (ctxCompleted) {
      ctx["completed_nodes"] = ctxCompleted.filter((x) => (typeof x === "string" ? x : "") !== failedNode);
    }
    delete ctx["tool.output"];
    const internalKey = `internal.retry_count.${failedNode}`;
    if (internalKey in ctx) ctx[internalKey] = 0;
  }

  const nr = cp["node_retries"] as Record<string, unknown> | undefined;
  if (nr && failedNode in nr) nr[failedNode] = 0;

  const stageDir = join(runDir, failedNode);
  await mkdir(stageDir, { recursive: true });
  try {
    await rm(join(stageDir, "stage.tgz"), { force: true });
  } catch {
    /* ok */
  }
  const failStatus = JSON.stringify({
    status: "fail",
    failure_reason: "exit status 1",
  });
  await writeFile(join(stageDir, "status.json"), failStatus, "utf8");
  await writeFile(join(stageDir, "stdout.log"), "(resumed)\n", "utf8");
  await writeFile(join(stageDir, "stderr.log"), "", "utf8");

  const extra = cp["extra"] as Record<string, unknown> | undefined;
  if (extra) {
    delete extra["loop_failure_signatures"];
    extra["restart_count"] = 0;
  }

  try {
    await rm(join(runDir, "final.json"), { force: true });
  } catch {
    /* ok */
  }

  await writeFile(cpPath, JSON.stringify(cp, null, 2), "utf8");
}
