# Generated Rule: src

- Source: `src/AGENTS.md`
- Scope: files under `src`
- Repo: `kilroy-run-pane`

# `src` Rules

## Purpose

- Contain the client-side run-pane application code.

## Key Files

- `main.tsx`: frontend bootstrap entrypoint
- `AGENTS.md`: authored directory rules for this scope
- `index.css`: tracked file that anchors this directory's workflow

## Testing

- Run `npm run build` from this repo root for broad validation.
- Use `npm run build:client` or `npm run build:server` when you need a narrower check while iterating.

## Change Guidance

- Keep UI structure intentional and consistent with the existing run-pane interaction model.
- Prefer shared hooks/lib helpers over duplicating state wiring across components.
