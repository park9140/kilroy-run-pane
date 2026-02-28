/**
 * Freshell pane component for Kilroy Run Viewer.
 *
 * Renders an iframe that points to the kilroy-run-pane server.
 * The pane receives a KilroyRunPaneContent object from freshell's
 * pane registry.
 *
 * Integration steps — see INTEGRATION.md for file locations.
 */

// NOTE: This file assumes freshell's React version and types.
// Adjust imports to match the freshell codebase.

interface KilroyRunPaneContent {
  type: "kilroy-run";
  runId: string;
  runsDir: string;
  viewerPort: number;
}

interface Props {
  pane: KilroyRunPaneContent;
}

export function KilroyRunPane({ pane }: Props) {
  const port = pane.viewerPort ?? 3737;
  const src = `http://localhost:${port}/run/${encodeURIComponent(pane.runId)}`;

  return (
    <iframe
      src={src}
      title={`Kilroy Run: ${pane.runId}`}
      className="w-full h-full border-0"
      style={{ display: "block", width: "100%", height: "100%", border: "none" }}
    />
  );
}
