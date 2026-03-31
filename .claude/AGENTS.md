# `.claude` Rules

## Purpose

- Hold configuration and compatibility files for the `.claude` tool scope.

## Key Files

- `settings.json`: tooling configuration for the owning agent/runtime

## Testing

- Run `npm run build` from this repo root for broad validation.
- Use `npm run build:client` or `npm run build:server` when you need a narrower check while iterating.

## Change Guidance

- Keep durable local guidance for `.claude` here instead of expanding the root file.
- If you discover recurring pitfalls or stable entrypoints while working in this directory, update this `AGENTS.md` in the same change.
