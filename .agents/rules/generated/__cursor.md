# Generated Rule: .cursor

- Source: `.cursor/AGENTS.md`
- Scope: files under `.cursor`
- Repo: `kilroy-run-pane`

# `.cursor` Rules

## Purpose

- Hold configuration and compatibility files for the `.cursor` tool scope.

## Key Files

- `AGENTS.md`: authored directory rules for this scope
- `hooks.json`: agent hook wiring for reminders or automation

## Testing

- Run `npm run build` from this repo root for broad validation.
- Use `npm run build:client` or `npm run build:server` when you need a narrower check while iterating.

## Change Guidance

- Keep durable local guidance for `.cursor` here instead of expanding the root file.
- If you discover recurring pitfalls or stable entrypoints while working in this directory, update this `AGENTS.md` in the same change.
