# `server` Rules

## Purpose

- Implement the local server that watches runs and serves the run-pane UI.

## Key Files

- `index.ts`: local TypeScript entrypoint
- `AGENTS.md`: authored directory rules for this scope
- `checkpointRepair.ts`: TypeScript source in this directory's local surface area
- `factory.ts`: TypeScript source in this directory's local surface area

## Testing

- Run `npm run build` from this repo root for broad validation.
- Use `npm run build:client` or `npm run build:server` when you need a narrower check while iterating.

## Change Guidance

- Keep server routes and watcher logic explicit; this repo has build checks but not a broad automated test harness yet.
- When changing server/client contracts, update both sides in the same change.
