/**
 * Freshell pane content type for Kilroy Run Viewer.
 *
 * Add this interface to freshell's pane type union:
 *   src/types/panes.ts  (client-side)
 *   server/tabs-registry/types.ts  (server-side)
 */
export interface KilroyRunPaneContent {
  type: "kilroy-run";
  /** Kilroy run ID (ULID), e.g. "01KJ8JV4KY1STFCFA7EBXNSD9N" */
  runId: string;
  /**
   * Host path to the .kilroy/runs directory.
   * Passed to the kilroy-run-pane server via KILROY_RUNS_DIR env var.
   * Example: "/Users/alice/src/myproject/.kilroy/runs"
   */
  runsDir: string;
  /**
   * Port the kilroy-run-pane server is listening on.
   * Default: 3737
   */
  viewerPort: number;
}
