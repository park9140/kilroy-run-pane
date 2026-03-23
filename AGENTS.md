# Root Rules

## Purpose

- Build the run-pane frontend, local server, and freshell integration used to inspect and proxy run output.
- Keep repo-wide instructions here and put feature or subsystem detail into the nearest directory `AGENTS.md`.

## Key Files

- `package.json`: top-level scripts for dev, build, preview, and local server startup
- `server/index.ts`: Express server entrypoint for local run-pane hosting
- `server/factory.ts`: authenticated factory API (`KILROY_FACTORY_TOKEN`) to start/resume attractor from the dashboard; registered from `index.ts`
- `server/checkpointRepair.ts`: checkpoint repair helper for embedded resume (mirrors kilroy-dash semantics)
- `src/main.tsx`: frontend bootstrap for the React client
- `freshell/KilroyRunPane.tsx`: freshell integration surface for embedding the pane

## Testing

- This repo currently exposes build-first validation: `npm run build` from the repo root.
- For server-only edits, also run `npm run build:server` when you need a narrower check.
- For client-only edits, `npm run build:client` is the narrowest bundled validation.

## Change Guidance

- Edit `AGENTS.md` files as the authored rules source. Generated compatibility artifacts must come from the shared sync script.
- Keep frontend guidance under `src/`, server guidance under `server/`, and freshell-specific behavior under `freshell/`.
- If you add linting, tests, or new subsystems, update the nearest `AGENTS.md` so future agents see the right local expectations.
