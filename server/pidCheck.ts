import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Check whether a Docker container is currently running.
 * Returns true if the container exists and is in "running" state.
 * Returns false if the container is stopped, missing, or on error.
 */
export async function checkContainerAlive(containerId: string): Promise<boolean> {
  if (!containerId) return false;
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}",
      containerId,
    ], { timeout: 5000 });
    return stdout.trim() === "running";
  } catch {
    return false;
  }
}
