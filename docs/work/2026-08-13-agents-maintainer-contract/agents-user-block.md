# AGENTS.md USER block — maintainer contract

**Status: authored, not yet applied.** The text below is the exact content that
belongs between `<!-- USER:START -->` and `<!-- USER:END -->` in `AGENTS.md`.

It could not be committed into `AGENTS.md` in this PR. `AGENTS.md` classifies as
protected surface `generated_harness`, and the only command that can issue a
protected-state authorization is `forge release generate-npm-workflow`
(`NPM_WORKFLOW_SOURCE_COMMAND`, `lib/protected-state-authority.js`). There is no
writer for a USER-block edit — the product invites users to write in that block
and then refuses the commit. That is filed as a product bug; this file holds the
content until the gate has a writer, at which point applying it is a copy-paste
plus one `forge setup` run.

Verified while writing this (2026-08-13):

- `smartMergeAgentsMd` (`lib/smart-merge.js`) extracts the USER block by regex
  and re-emits it, so **`forge setup` preserves USER-block content** — but it
  re-emits it **above** the FORGE block regardless of where it was.
- The runtime protected surface for `AGENTS.md` is **`generated_harness`**, not
  `user_protocol`. The `categories:` block in `.forge/protected-paths.yaml`
  (`forge_core`, `user_protocol`, …) is documentation; enforcement uses the
  hardcoded `PROTECTED_SURFACES` list in `lib/protected-state-surfaces.js`.
- `FORGE_PROTECTED_STATE_ALLOWED_SURFACES` is read by no runtime code path.

---

<!-- USER:START -->

## For people building Forge

Everything above this line is the **product contract**. It is rendered by Forge,
it ships to every user, and it must read as if written for someone who has never
seen this repository — no repo-local paths, no script names, no hook files, no
maintainer trivia. Do not hand-edit it to record something you learned while
building Forge; that belongs here.

This block is ours. It survives `forge setup`. If you are changing Forge, read
this and the skills in `.forge/contributor-skills/`. Do **not** read
`skills/**` or `.agents/skills/**` as instructions for yourself — those are
product artifacts describing what a *user's* agent does. A Codex session once
took `using-forge/SKILL.md` as its own operating manual while building Forge.
[Forge product-vs-maintainer confusion ×5]

Per tree: `skills/` is **authored and published**. `.agents/skills/` is
**generated and committed** (Codex's repo-local discovery path). `.claude/`,
`.codex/`, `.cursor/`, `.hermes/` skill dirs are **generated and gitignored**.
`.forge/contributor-skills/` is **authored, tracked, never published**.

### These are good defaults, not hard rules

The human in the session overrides anything written here. If a rule below fights
the task in front of you, say so loudly and get sign-off before breaking it —
don't quietly route around it, and don't obey it into a bad outcome.

### What we can never compromise on

Reject your own diff against this list before you open a PR.

- **Agent-agnostic.** Classify by mechanism, never by vendor name. *"it coudl be
  any new bot we might not even know so we shoudl be agnostic on logic."*
  A review thread is a review thread whether CodeRabbit, Greptile, Qodo, or a
  person wrote it. [Forge glossary]
- **Self-enforcing.** *"It should always hard stop by default. No exceptional
  cases."* Enforcement lives in gates and hooks, not in prose that an agent may
  or may not read. If the only thing stopping a mistake is an instruction, it
  isn't stopped.
- **One source of truth; everything else generated.** *"why should we do the
  work"* — the skill CLI generates every agent directory. Drift is a test
  failure. [Forge #5 ×4]
- **User-extensible.** Every rail can be toggled, swapped, or replaced.
  *"when someone wants to install their own workflow, like maybe superpowers…
  they should be able to turn off the current skills… and install the superpowers
  template."* We ship the hammer and the shovel, not a fixed ladder.
- **Independent automation.** Anything you must remember to invoke has no value.
  *"shepard should do everything independtly thats teh idea it shouldntbe
  invoked."* [Forge #1 ×10]
- **Dogfooded.** Forge tracks its own work in its own kernel. If a workflow is
  painful for us, it is worse for a user.

### A note from Harsha

> *Draft — written from Harsha's own words in session history. Harsha, edit this
> into your voice; it is meant to be yours, not a summary of you.*

Forge is a substrate, not a script. The point is that the capability holds no
matter which agent or model is driving — so it goes in the kernel, in a gate, in
a hook. Not in a paragraph.

Keep the names short. `status`, `ready`, `ship`. If a command name needs
explaining, it's the wrong name.

If a change needs paragraphs to defend it, it's the wrong change. Do it the
right way instead — the right fix is usually shorter than the workaround.

And watch the review cycles. Forty-four comments on a two-hundred-line PR does
not mean the reviewers are thorough; it means we're not working right. Know when
to stop.

File everything. Anything discussed, decided, noticed in passing — it goes in
the kernel as an issue immediately, or it is gone.

### Glossary — in the user's words

Use these terms when you talk back to me. When something I dictate is a near
match for one of these, resolve it to the entry and say which one you read it as.

| Term | What it means here |
|---|---|
| **kernel** | Forge's own SQLite issue store — "our own thing", the thing that replaced beads. Synced to git issues. |
| **beads** | Legacy. A **migration surface only, never a live backend** — *"would have been only a reference as a migration feature and not as a using feature."* |
| **shepherd** | The autonomous PR watcher. It must run itself. If it has to be invoked, it has failed. |
| **ship** | Push *and* auto-arm the monitor. The two are one action — *"whenever we ship an automatic pr monitor should be created to work on all fixes until iut gets merghe ready."* |
| **gate** | A hard block, not advice. *"It should always hard stop by default."* Instruction-only enforcement is a failure mode. |
| **hook** | The delivery mechanism that makes a gate agent-proof — *"beyond any agent."* |
| **rail / guardrail** | A runtime toggle that arms a behaviour: `rail.auto_shepherd`, `rail.grounding`, `rail.tdd_intent`, `rail.kernel_tracking`. |
| **worktree** | Mandatory isolation, one per agent. A worktree must never silently lose hook protection. |
| **claim** | A lease on an issue taken before work starts; gated by `read_first`. Note: a claim sets `claimed_by`, it does **not** set `assignee`. |
| **assignee** | Who owns the issue. Set it explicitly — claiming does not. |
| **stage** | plan → dev → validate → ship → review → premerge → verify. Enforced and extensible — *"the user might want to create new substages."* |
| **smith** | The orchestrator's name. Kept for brand. Decides human-in-the-loop by issue size. |
| **skill / single source** | One canonical source under `skills/`; every agent directory is generated from it by the skill CLI. |
| **mirror** | A generated per-harness copy. Drift is a test failure. Never hand-edit one. |
| **harness** | Any agent runtime — Claude Code, Codex, Cursor, Kilo, OpenCode. Forge is neutral to all of them. |
| **agent-agnostic** | Classify by mechanism, never vendor name. |
| **dogfood** | Forge tracks its own work in its own kernel. |
| **merge train** | Sequential merges, parallel builds on non-conflicting surfaces. Update only the branch next at bat. |
| **triage** | Auto-grooming, so issues don't rot. |

People: **you** = the agent reading this. **we/us** = Harsha and whoever is
building. **user** = the person driving the session. **harness** = the runtime
you happen to be running in.

### Ways to hurt yourself

Mined from real corrections in this repo, most frequent first.

1. **Treating beads as a live backend.** It is an import path and nothing else.
   `forge migrate --from beads` once, then never again. [Forge #4 ×5]
2. **Hand-editing a generated mirror.** `.agents/skills`, `.claude/skills`,
   `.codex/skills`, `.cursor/skills`, `.hermes/skills` are all output. Edit
   `skills/` and run the generator; the drift gate is the contract. [Forge #5 ×4]
3. **Re-implementing what the skill CLI already does.** Use Forge's own
   generator. [Forge #5 ×4]
4. **Working outside a worktree**, or two agents leading one PR. [Forge #6 ×4]
5. **Weakening a gate or a test to make it pass** — a bumped timeout, a
   softened assertion, a narrowed scope so the check stops firing. If a gate
   caught you, it worked. [Forge #9 ×3]
6. **Skipping the manifest regen** after adding a command file. Dev-mode
   discovery hides it locally; the compiled binary does not.
7. **`--no-verify` / `LEFTHOOK=0`.** Forbidden for agents, no exceptions.
8. **Letting a PR sit.** Over-analysis instead of merging is the second most
   common complaint in this repo. [Forge #2 ×9]
9. **Pulling unrelated fixes into the current PR.** New problem → new issue →
   new PR. [Forge #3 ×6]
10. **Leaving something discussed unfiled.** If it was said, it is an issue.
    [Forge #7 ×3]

### Hit every surface

**Walk this list out loud and say which entries apply to your change** — including
the ones that don't, and why. Silence on a row reads as "didn't check".

| Change | Everything it also touches |
|---|---|
| A command file in `lib/commands/` | Regenerate the static manifest, confirm the CLI registry resolves it, add or exempt it in `skills/coverage.json`, and give it a test-lane mapping. |
| Anything under `skills/**` | The `.agents/skills` mirror must be re-synced byte-identically, and the whole tree is published — check nothing maintainer-only leaked in. |
| A new user-facing command | An owning skill in `skills/coverage.json`, or an explicit exemption with a real reason. Exempt means complete, not deferred. |
| A new top-level path | `isKnownTargetablePath` **and** a direct test mapping. Miss either and every push takes the ten-minute full-suite lane. |
| Any parallel or concurrent work | Its own worktree, created with `forge worktree create` from the primary root. Never raw `git worktree add`, never the shared checkout. |
| `AGENTS.md` | Protected state — read the `protected-commit` skill first. And decide which block the text belongs in. |
| **Reverse states** | Every state you can enter, you must be able to leave: arm ⇒ disarm, claim ⇒ release, enable ⇒ disable, attach ⇒ detach. Ship the reverse in the same PR. |
| **Per-harness decision** | Claude, Codex, Cursor, Kilo, OpenCode — state a decision for each one, **including an explicit "not supported yet"**. An unmentioned harness is an unowned harness. |
| A CLI JSON field | Something downstream consumes it. Say what, or say nothing consumes it yet. |
| A new gate | Hook wiring, a rail toggle, a stated default state, and a test that proves it is genuinely inert when the rail is off. |
| Docs | User docs and maintainer docs are two trees. Decide which one, every time. |

### Dev runbook — the exact spellings

```
node bin/forge.js <command>                 # the CLI, from source
forge worktree create <slug>                # never raw `git worktree add`
node scripts/gen-command-manifest.js        # after any lib/commands/ file change
node scripts/gen-command-manifest.js --check
forge shepherd <pr> --pull --json           # read the verdict; never poll gh in a loop
forge push / forge push --quick             # push through the lane, not around it
forge clean                                 # from the primary root, main fast-forwarded first
```

Protected-state commits: there is **no environment variable that authorizes a
protected write.** `FORGE_PROTECTED_STATE_ALLOWED_SURFACES` is read by no
runtime code path — not `generated_harness`, not `forge_core`, not anything.
Authorization is a one-time, content-bound kernel capability issued by the
owning command. If no owning command exists for your path, the change is
unshippable today: file the issue and say so. Never `--no-verify`.

Test data: use temp paths only. Never `'/repo'` or `'/gcd'` in a test — on
Windows those write to real drive roots and give you a vacuously green local run
and a red Linux CI.

Verification: CI green, not local green. `gh pr checks`, or the shepherd verdict.

Pull requests: problem first in plain English, then the solution — never an
implementation inventory. No draft PRs (bots don't run on drafts). One lead
agent per PR. End with the model and harness that produced it.

### Standards, as a user would feel them

The CLI feels instant. No spinner that lies about what it's doing. Hooks add no
latency you can perceive. An error names the thing to do next. Security effort
is proportionate — maintainer-only, dev-mode surfaces do not get the treatment a
published credential path gets. And internal-only is a statement of risk, never a
licence to ship a maintainer's assumptions: a hardcoded local path has shipped
from this repo before.

<!-- USER:END -->
