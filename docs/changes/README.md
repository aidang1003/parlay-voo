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

Use `A_DAY_SPRINT.md` as the shape template (Part 1 narrative; bullet sections that lead with *why*).

## Filename convention

`<SHORT_SLUG>.md` in SCREAMING_SNAKE_CASE. Examples:
- `A_DAY_SPRINT.md` — first heads-down sprint (scaling + arch cleanup + UX polish)
- `B_SLOG_SPRINT.md` — second sprint (correlation engine + UMA oracle + onboarding + UX overhaul)
- `BACKLOG.md` — deferred work + design sketches that haven't found a sprint yet
- `REHAB_MODE_ROLLOUT.md` (hypothetical) — when a multi-phase feature lands and you want the story of how it rolled out

No dates in filenames — commit history carries that. Order by opening the folder in git-log order if you need chronology.

Sprint docs collapse multiple change docs once the work is done — keep the *why* behind each piece, drop the implementation detail (it lives in the architecture docs and the code itself).

## When the change lands

Update the matching live doc (`../ARCHITECTURE.md`, `../REHAB_MODE.md`, etc.) in the same PR that ships the code. The change doc is the story; the live doc is the snapshot. They drift apart quickly if you update only one.
