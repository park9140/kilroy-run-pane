# `.cursor` Rules

## Purpose

- Hold configuration and compatibility files for the `.cursor` tool scope.

## Key Files

- `hooks.json`: agent hook wiring for reminders or automation

## Testing

- Run `npm run build` from this repo root for broad validation.
- Use `npm run build:client` or `npm run build:server` when you need a narrower check while iterating.

## Change Guidance

- Keep durable local guidance for `.cursor` here instead of expanding the root file.
- If you discover recurring pitfalls or stable entrypoints while working in this directory, update this `AGENTS.md` in the same change.
