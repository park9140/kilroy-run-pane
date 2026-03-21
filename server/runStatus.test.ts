import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRunArtifactStatus } from "./runStatus.js";

async function makeRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "run-status-"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

test("failed top-level stage overrides success final", async () => {
  const root = await makeRunDir();
  await mkdir(join(root, "deliver"), { recursive: true });
  await writeJson(join(root, "final.json"), { status: "success" });
  await writeJson(join(root, "deliver", "status.json"), {
    status: "fail",
    failure_reason: "delivery failed",
  });

  const status = await readRunArtifactStatus(root);

  assert.equal(status.status, "failed");
  assert.equal(status.failureReason, "delivery failed");
  assert.deepEqual(status.failedStage, {
    nodeId: "deliver",
    status: "fail",
    failureReason: "delivery failed",
  });
});

test("success final stays completed when no top-level stage fails", async () => {
  const root = await makeRunDir();
  await mkdir(join(root, "deliver"), { recursive: true });
  await writeJson(join(root, "final.json"), { status: "success" });
  await writeJson(join(root, "deliver", "status.json"), { status: "success" });

  const status = await readRunArtifactStatus(root);

  assert.equal(status.status, "completed");
  assert.equal(status.failureReason, undefined);
  assert.equal(status.failedStage, undefined);
});

test("live failed event is terminal without final.json", async () => {
  const root = await makeRunDir();
  await writeJson(join(root, "live.json"), {
    event: "failed",
    failure_reason: "live failure",
    ts: "2026-03-20T00:00:00Z",
  });

  const status = await readRunArtifactStatus(root);

  assert.equal(status.status, "failed");
  assert.equal(status.failureReason, "live failure");
  assert.equal(status.finishedAt, "2026-03-20T00:00:00Z");
});

test("live interrupted event is terminal without final.json", async () => {
  const root = await makeRunDir();
  await writeJson(join(root, "live.json"), {
    event: "interrupted",
    ts: "2026-03-20T00:00:01Z",
  });

  const status = await readRunArtifactStatus(root);

  assert.equal(status.status, "interrupted");
  assert.equal(status.failureReason, undefined);
  assert.equal(status.finishedAt, "2026-03-20T00:00:01Z");
});
