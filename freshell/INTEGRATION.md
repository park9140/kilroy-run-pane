# Freshell Integration Guide

This document describes how to add the `kilroy-run` pane type to a freshell checkout.

## Overview

The kilroy-run pane renders an iframe pointed at the `kilroy-run-pane` server
running on `http://localhost:3737`. The pane requires:

1. The `kilroy-run-pane` server running (`npm start` or `npm run dev`)
2. The pane content type registered in freshell

## Files to Modify

### 1. `src/types/panes.ts` (or equivalent)

Add `KilroyRunPaneContent` to the pane type union:

```diff
+export interface KilroyRunPaneContent {
+  type: "kilroy-run";
+  runId: string;
+  runsDir: string;
+  viewerPort: number;
+}
+
 export type PaneContent =
   | BrowserPaneContent
   | TerminalPaneContent
+  | KilroyRunPaneContent
   | ...;
```

### 2. `server/tabs-registry/types.ts` (or equivalent)

Add the same interface to the server-side type union so the tab registry
can persist and restore kilroy-run panes.

### 3. `src/components/panes/PaneContainer.tsx` (or equivalent)

Add a branch to the pane renderer switch/if-else:

```diff
+import { KilroyRunPane } from "./KilroyRunPane";

 // Inside the render function:
+if (pane.content.type === "kilroy-run") {
+  return <KilroyRunPane pane={pane.content} />;
+}
```

Copy `KilroyRunPane.tsx` from this directory into
`src/components/panes/KilroyRunPane.tsx`.

### 4. `src/components/panes/PanePicker.tsx` (optional)

Add a "Kilroy Run" entry to the pane picker UI so users can open runs
from freshell's UI:

```diff
+{
+  type: "kilroy-run",
+  label: "Kilroy Run",
+  icon: "activity",
+  description: "View a Kilroy pipeline run",
+  defaultContent: {
+    type: "kilroy-run",
+    runId: "",
+    runsDir: process.env.KILROY_RUNS_DIR ?? "",
+    viewerPort: 3737,
+  },
+},
```

## Server Setup

The `kilroy-run-pane` server must be running before opening the pane.

```bash
cd .kilroy/repos/kilroy-run-pane
npm install
npm run build

# Start the server (reads .kilroy/runs/ by default)
npm start
# or, pointing to a specific runs dir:
KILROY_RUNS_DIR=/path/to/.kilroy/runs npm start
```

The server listens on port 3737 by default. Set `PORT` env to change it.

## Opening a Run Pane Programmatically

```typescript
// In freshell's tab-creation logic:
const paneContent: KilroyRunPaneContent = {
  type: "kilroy-run",
  runId: "01KJ8JV4KY1STFCFA7EBXNSD9N",
  runsDir: "/path/to/.kilroy/runs",
  viewerPort: 3737,
};
createPane(paneContent);
```

## Architecture Notes

- The iframe approach requires no modifications to freshell internals beyond
  the pane type registration.
- The kilroy-run-pane server proxies stage/DOT data from kilroy-dash (port 8090)
  so kilroy-dash must also be running for full stage details.
- For purely local use (no kilroy-dash), the server still shows run status
  and the DOT graph won't be available.
