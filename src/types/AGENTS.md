# `src/types` Rules

## Purpose

- Implement the run-pane frontend area under `src/types`.

## Key Files

- `AGENTS.md`: authored directory rules for this scope
- `file-system-access.d.ts`: TypeScript source in this directory's local surface area

## Testing

- Run `npm run build` from this repo root for broad validation.
- Use `npm run build:client` or `npm run build:server` when you need a narrower check while iterating.

## Change Guidance

- Keep UI structure intentional and consistent with the existing run-pane interaction model.
- Prefer shared hooks/lib helpers over duplicating state wiring across components.
