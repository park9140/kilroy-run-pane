# Generated Rule: freshell

- Source: `freshell/AGENTS.md`
- Scope: files under `freshell`
- Repo: `kilroy-run-pane`

# `freshell` Rules

## Purpose

- Contain the freshell integration surface for embedding or proxying the run pane.

## Key Files

- `INTEGRATION.md`: local markdown documentation or planning context
- `KilroyRunPane.tsx`: TypeScript source in this directory's local surface area
- `KilroyRunPaneContent.ts`: TypeScript source in this directory's local surface area

## Testing

- Run `npm run build` from this repo root for broad validation.
- Use `npm run build:client` or `npm run build:server` when you need a narrower check while iterating.

## Change Guidance

- Keep durable local guidance for `freshell` here instead of expanding the root file.
- If you discover recurring pitfalls or stable entrypoints while working in this directory, update this `AGENTS.md` in the same change.
