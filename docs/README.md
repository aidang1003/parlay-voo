# Docs

Human-readable documentation for ParlayVoo. LLM-oriented implementation detail lives in `llm-spec/`; you shouldn't need to open that folder.

## Where to start

- **New to the repo?** Read the root `README.md`, then `ARCHITECTURE.md` here.
- **Shipping changes?** Read `RUNBOOK.md` for commands and `DEPLOYMENT.md` for how deploys work.
- **Touching a subsystem?** Open the matching file below — each describes one feature area end-to-end.
- **Asking "why is it like this?"** Open `changes/` and read the most recent entry. That's the architectural diary.

## Files

### Reference — "how the system is"

| File | What it covers |
|---|---|
| `ARCHITECTURE.md` | Whole-system diagram, contract roles, data flow |
| `THREAT_MODEL.md` | Assets, threats, mitigations |
| `MCP.md` | The live `/api/mcp` endpoint exposed to external AI agents |

### Ops — "how to run it"

| File | What it covers |
|---|---|
| `RUNBOOK.md` | Day-to-day commands, common operations, troubleshooting |
| `DEPLOYMENT.md` | Local + Base Sepolia deploy flows, env vars, post-deploy checklist |

### Subsystem specs — "how feature X works"

Each file below has an LLM-spec mirror at `llm-spec/<same-name>.md`. The human doc is the one to read; the mirror exists for LLMs editing the code.

| File | What it covers |
|---|---|
| `REHAB_MODE.md` | Loss → locked principal + bet-only credit → Partial → Full graduation |
| `CASHOUT.md` | Crash-parlay early cashout pricing and flow |
| `RISK_MODEL.md` | Utilization caps, exposure accounting, pricing |
| `POLYMARKET.md` | Curated market sync + resolution relay |
| `UNISWAP_LP_STRATEGY.md` | Planned yield strategy for idle vault capital |

### Backlog — "what's deferred"

| File | What it covers |
|---|---|
| `BACKLOG.md` | Ideas that aren't scheduled. Not a roadmap promise. |

### Subfolders

- `changes/` — chronological log of architectural changes. One file per significant change. Read the latest if you need to catch up fast.
- `llm-spec/` — LLM-only mirror of subsystem specs. Humans can ignore.

## When you edit a doc

- Touch a subsystem spec? Update its mirror in `llm-spec/` in the same commit.
- Make a structural change (move a file, add a subsystem, retire a module)? Add a new change doc in `changes/` and update the affected reference files together.
- Nothing in this folder is auto-generated. If a doc is out of date, fix it in a PR — the change won't propagate on its own.
