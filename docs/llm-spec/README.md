# LLM spec

This folder is the LLM-oriented mirror of `docs/`. Humans do not need to read these files — the matching human doc (`docs/<same-name>.md`) is complete on its own.

## Why this folder exists

Every subsystem spec has two audiences:

- **Humans** who want to understand what the feature is and why it's designed this way → `docs/<name>.md`.
- **LLMs** (or humans acting like LLMs) who need a dense, machine-readable implementation reference — function signatures, state layout, call graphs, invariants, test checklists, files touched → `docs/llm-spec/<name>.md`.

Splitting them into two files keeps the human doc skimmable and the LLM doc dense. Neither has to compromise for the other.

## Conventions

- Filename matches the human doc exactly. `docs/REHAB_MODE.md` ↔ `docs/llm-spec/REHAB_MODE.md`.
- The human doc carries a link to the mirror as its first content line: `*LLM spec: [llm-spec/<name>.md](llm-spec/<name>.md)*`.
- When editing the human doc, update the mirror in the same commit. When editing only the mirror, check whether the human doc also drifted — usually it did.
- Not every doc in `docs/` has a mirror. Reference docs (`ARCHITECTURE`, `DEPLOYMENT`, `RUNBOOK`, `THREAT_MODEL`, `MCP`, `BACKLOG`) do not mirror. Change docs (`docs/changes/*.md`) do not mirror; if they need an AI spec, it goes inline in the change doc itself.

## What to put here

- Rename tables (old symbol → new symbol across the codebase).
- Constants and parameter values.
- State additions per contract (field name + type + semantics).
- Access-control tables (function → caller).
- Function signatures.
- Call graphs (`X → Y → Z`).
- Events emitted.
- Invariants to enforce in tests.
- Test requirements (unit / fuzz / invariant / integration).
- Files touched (expected paths).

## What *not* to put here

- Narrative about why a feature exists — that's the human doc.
- Deep rationale behind a design choice — human doc.
- User-facing flow descriptions — human doc.
- Duplicate content from the human doc copy-pasted — link to it instead.
