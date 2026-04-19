# Changes

Chronological record of architectural changes. One file per significant change. Open the latest file first if you want to catch up on what moved recently.

## When to add a file here

- You reorganized the repo (folders moved, packages split, docs restructured).
- You replaced a subsystem (V1 → V2 of a contract, swapped out an API).
- You deleted something non-trivial (dead code, legacy flow).
- You adopted or retired a convention (naming scheme, test structure, docs format).

If you only fixed a bug or added a feature inside an existing subsystem, a commit message plus an update to the matching subsystem spec is enough — don't add a change doc.

## Format

Each change doc uses the two-part pattern:

- **Part 1 — Human Spec.** What the change is, what it does, key design decisions, what the next contributor sees. Bullet-heavy, skimmable, no function signatures.
- **Part 2 — AI Spec Sheet** (optional). Terse implementation reference for an LLM — file operations, dead references, invariants preserved. Add this only when the change has a mechanical implementation plan worth laying out. Keep it inline in the same file; change docs do **not** mirror into `llm-spec/`.

Use `ARCH_REVIEW_2.md` as the template.

## Filename convention

`<SHORT_SLUG>.md` in SCREAMING_SNAKE_CASE. Examples:
- `ARCH_REVIEW_2.md` — second round of architecture cleanup
- `A_DAY_SCALING_SPRINT.md` — scaling-sprint working doc, archived here when the sprint ended
- `REHAB_MODE_ROLLOUT.md` (hypothetical) — when a multi-phase feature lands and you want the story of how it rolled out

No dates in filenames — commit history carries that. Order by opening the folder in git-log order if you need chronology.

## When the change lands

Update the matching live doc (`../ARCHITECTURE.md`, `../REHAB_MODE.md`, etc.) in the same PR that ships the code. The change doc is the story; the live doc is the snapshot. They drift apart quickly if you update only one.
