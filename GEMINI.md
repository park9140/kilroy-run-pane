# Gemini Bridge

- `AGENTS.md` is the authored source of truth for shared agent instructions in this repo.
- Use the nearest `AGENTS.md` for the directory you read or edit, layered with parent rules from the repo root.
- Prefer the generated `.agents/rules/generated/` path-scoped rules instead of trying to mirror the entire `AGENTS.md` tree in this file.
- After changing any `AGENTS.md` file, rerun `node ../../../scripts/sync-agent-rules.mjs` so generated compatibility artifacts stay in sync.

Authoritative instructions live in the `AGENTS.md` tree for this repo. Use the nearest `AGENTS.md` while editing files, layered with parent rules from the root. Generated Antigravity-compatible workspace rules live under `.agents/rules/generated/`, and `CLAUDE.md` files are generated from each `AGENTS.md`. Run `node ../../../scripts/sync-agent-rules.mjs` after editing any `AGENTS.md` file in this repo.
