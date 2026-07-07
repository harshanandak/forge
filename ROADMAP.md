# Forge Roadmap

What's coming to Forge, organized by theme. Everything here is **planned or in
flight — no dates, no promises**, and nothing is listed as shipped unless it is
verifiably on the default branch. For what Forge delivers *today*, see the
[README](README.md) and the honest
[per-agent capability matrix](docs/reference/AGENT_SKILL_PARITY.md).

**The toggle philosophy carries through everything below**: safety and hygiene
rails ship **default-on** so you're protected without configuring anything, and
**every one of them is opt-out-able** (`forge gate disable <gate-id>`) — Forge
gives you guardrails, not a cage.

## How to read this

| Status | Meaning |
| --- | --- |
| **Now** | Actively being built or in final review |
| **Next** | Queued — design settled, work not started |
| **Later** | Planned — direction committed, details open |

---

## Trustworthy writes and kernel hygiene

You should never have to wonder whether the tracker actually recorded what the
agent said it did.

| What you get | Status |
| --- | --- |
| **Verified issue writes** — every kernel mutation is re-read and confirmed after writing (`verified: true` in the response); it caught a real projection bug on its very first run | Now |
| **Short issue ids** — refer to issues by a short prefix instead of pasting a full UUID | Next |
| **One canonical issue command surface** — a single, predictable `issue` noun before the 0.1.0 API freeze | Next |
| **Board hygiene + 0.1.0 release** — a groomed, deduplicated public board and a stable release line | Next |
| **Per-agent claim identity** — concurrent agents get distinct identities so two sessions can never silently claim the same work | Next |
| **Issue-to-code provenance** — every issue linked to its worktree, work folder, and files, so "what changed for this?" has one answer | Later |

## Review before you push

Catch review feedback on your machine, before the PR — not twenty minutes after.

| What you get | Status |
| --- | --- |
| **Configurable pre-push review** — run your review tool of choice (CodeRabbit, Qodo, Greptile, or a native reviewer) locally as a push gate | Next |
| **SARIF + reviewdog compatibility** — standard finding formats in and out, so Forge plugs into the review tooling you already run | Next |
| **Self-improving workflow loop** — recurring review feedback proposes improvements to the dev/validate skills themselves, always behind a human approval gate | Later |

## A workflow that checks itself

The stages you run should verify their own exits — structurally, not by
convention.

| What you get | Status |
| --- | --- |
| **Stage-exit gate checks** — `forge gate check` wired into every stage exit, so a stage can't be "done" with its gates red | Next |
| **CI backstops for stage gates** — the same gate checks re-verified in CI, so nothing depends on the agent remembering | Next |
| **Composable stage skills** — invoke just the piece you need (research without a full plan, a single validate phase) or the full stage | Later |
| **Orchestrated stage composition** — a thin orchestrator that sizes autonomy to the work (small fix vs. new architecture) and composes stage sub-skills accordingly | Later |

## Memory that finds things

Remembering is easy; recalling the right thing at the right moment is the
feature.

| What you get | Status |
| --- | --- |
| **Indexed recall** — full-text-search-indexed memory so `forge recall` stays instant as the store grows | Next |
| **Recall in orientation** — session-entry commands surface relevant memory automatically, so agents start informed instead of cold | Next |
| **Knowledge-graph memory, fully wired** — the opt-in Graphiti backend connected over MCP for temporal, relational recall (available experimentally today) | Now |
| **Typed-memory projection** — structured memory rendered into each agent's instruction surface, not just readable on demand | Later |

## Deeper agent coverage

One canonical source should reach every surface each agent has — and say so
honestly where it can't yet.

| What you get | Status |
| --- | --- |
| **Subagent renderers per agent** — Forge-defined reviewer/implementer roles rendered to each agent's native subagent format | Next |
| **Codex MCP wiring** — MCP server config delivered for Codex's global config model, with the same consent guards as global hooks | Later |
| **Codex sandbox/approval defaults** — safe execution-policy defaults where Codex's trust model allows Forge to set them | Later |
| **Replaceable workflow packs** — a capability registry so whole workflow templates can be swapped or shared, not just toggled | Later |

## Easier every day

The default path should be the easy path — on every platform.

| What you get | Status |
| --- | --- |
| **Human-first CLI output** — readable text by default for `forge ready` and issue listings, `--json` when a machine is reading | Next |
| **Windows path robustness** — worktree cleanup that detects merged work correctly across path-separator styles | Now |
| **Unified Windows shell resolution** — one reliable Git Bash discovery path instead of per-command guesses | Next |
| **Onboarding wizard** — `forge new`: one guided setup from zero to a working, agent-ready project | Later |
| **Rollback with snapshots** — `forge rollback` restores from automatic pre-change backups when an upgrade or setup goes wrong | Later |
| **Background idea capture** — an opt-in agent that files kernel issues from conversation as you work, so capture costs zero keystrokes | Later |

---

## How this roadmap is maintained

Every line above is backed by a tracked issue in Forge's own issue kernel —
this project runs on Forge, and the "nothing discussed goes missing" rail
applies to the roadmap too. Items move **Later → Next → Now → README** as they
land; when something ships, it leaves this page and becomes a verifiable claim
in the [README](README.md) and the
[capability matrix](docs/reference/AGENT_SKILL_PARITY.md).

Statuses here are honest by policy: if it isn't merged, it isn't "done" — and
if a capability isn't delivered on an agent, the matrix says *not delivered*
rather than implying otherwise.
