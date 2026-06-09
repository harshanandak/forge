# Hook-Based Architecture Capture Enforcement

## Question

Can mandatory architecture-note capture become more effective by using hooks?

## Answer

Yes, but Lefthook should not be the center of the design. Agent-native hooks should be the preferred capture experience because they run while the agent still has the task intent, touched-file context, and discovered architecture facts in memory. Lefthook should be a repo-local Git adapter for humans and agents without native hooks, while CI remains the non-bypassable merge gate.

```text
agent-native hooks      = primary UX; contextual guidance/blocking before/during edits
Forge check engine      = shared policy implementation all adapters call
Lefthook/Git hooks      = optional repo-local adapter and human safety net
CI/required check       = non-bypass merge gate
future Kernel authority = server-side accepted decision/fact/conflict validation
```

This makes architecture capture hard to miss without pretending local hooks are reliable installation-state or security boundaries.

## Current Forge hook baseline

Forge already has Lefthook wiring:

```text
lefthook.yml
  commit-msg: node scripts/commitlint.js {1}
  pre-commit:
    protected-state: node scripts/protected-state-check.js
    tdd-check: node .forge/hooks/check-tdd.js
  pre-push:
    branch-protection: node scripts/branch-protection.js
    lint: node scripts/lint.js
    tests: node scripts/test.js
    team-sync: bash scripts/forge-team/lib/hooks.sh sync --quiet || true
```

This baseline is useful, but it has known drift risks: fresh worktrees, containers, agent sandboxes, or skipped installs can leave Lefthook shims missing. Therefore architecture capture should be implemented as Forge-owned policy plus adapters, not as Lefthook-owned policy.

## Recommended hook mechanism

### 0. Shared Forge policy engine

Implement architecture capture as Forge commands first:

```bash
forge architecture impact --mode agent|pre-commit|pre-push|ci
forge architecture check
forge hooks doctor
forge hooks install
forge hooks sync
```

Every hook surface should call the same engine:

```text
Hermes hook / instructions -> forge architecture impact
Claude Code hook           -> forge architecture impact
Cursor rule/hook           -> forge architecture impact
Codex workflow             -> forge architecture impact
Lefthook                   -> forge architecture impact
GitHub Actions / CI        -> forge architecture impact
```

Forge owns the policy and diagnostics; adapters only decide when to invoke it.

During CLI rollout, `scripts/architecture-impact-check.js` may exist only as a thin delegator to the Forge architecture service/CLI. It must not own divergent policy.

The commands need stable machine-readable output for agents, CI, and future MCP adapters:

```json
{
  "status": "pass | warn | block | error",
  "mode": "agent | pre-commit | pre-push | ci",
  "changed_files": [],
  "matched_scopes": [],
  "required_records": [],
  "declarations_found": [],
  "missing": [],
  "warnings": [],
  "bypass_allowed": false,
  "exit_code": 0
}
```

Exit-code policy: `0` pass, `1` blocking policy violation, `2` invalid config/input, `3` unexpected runtime error.

### 0.1 Hook adapter capability matrix

Forge should track adapter capability explicitly instead of assuming every harness supports blocking hooks:

| Surface | Blocking pre-edit | Advisory/session | Command wrapper | Doctor check | Fallback gate |
| --- | --- | --- | --- | --- | --- |
| Hermes | future adapter / project instructions | yes | yes | adapter file + project context present | CI |
| Claude Code | where native hooks support it | yes | yes | generated hook/config version | CI |
| Codex | verify current hook API before claiming | yes | yes | workflow/instruction version | CI |
| Cursor | rules/advisory unless native hooks exist | yes | yes | rules generated/stale | CI |
| Copilot/Kilo/OpenCode/Cline/Roo | adapter-specific; default advisory | yes | yes | generated guidance/stale | CI |
| Lefthook | Git boundary only | no task context | yes | git hooks path + shim present | CI |

If a harness lacks native blocking hooks, Forge should still generate guidance and rely on command wrappers plus CI. Agent hooks are UX/compliance aids, not security boundaries.

### 0.2 `forge hooks doctor/install/sync` contract

`forge hooks doctor` should be the canonical way to detect adapter drift across worktrees, containers, and agent sandboxes. Required checks:

- architecture-impact manifest exists and is schema-valid;
- Forge architecture policy command exists and reports a compatible version;
- agent adapter/guidance presence and version for detected harnesses;
- Lefthook config presence, Git `core.hooksPath`, installed shim, and stale/missing shim state;
- git worktree/common-dir routing and container path consistency;
- CI required check configuration, or a warning when remote branch protection cannot be verified locally.

Machine-readable output:

```json
{
  "status": "pass | warn | block | error",
  "repo_root": "...",
  "worktree": { "is_worktree": false, "common_dir": null, "status": "pass" },
  "manifest": { "present": true, "valid": true, "status": "pass" },
  "forge_policy": { "available": true, "version": "...", "status": "pass" },
  "agent_adapters": [],
  "lefthook": { "config_present": true, "shim_present": true, "hooks_path": ".lefthook/hooks", "status": "pass" },
  "ci": { "configured": true, "required_check": "architecture-impact", "status": "pass" },
  "repairs": [],
  "exit_code": 0
}
```

`install` and `sync` must be idempotent, support `--dry-run` and `--json`, avoid private/global agent profile writes unless explicitly authorized, and print safe repair commands instead of silently disabling existing protections.

### 1. Architecture impact manifest

Add a project-configurable manifest:

```text
.forge/architecture-impact.yaml
```

Example:

```yaml
version: 1
sensitive_paths:
  - glob: "lib/kernel/**"
    scope: "subsystem:kernel"
    topics:
      - "authority.local.storage"
      - "kernel.events"
    required: true

  - glob: "lib/knowledge/**"
    scope: "subsystem:knowledge"
    topics:
      - "knowledge.storage.boundary"
      - "knowledge.truth-model"
    required: true

  - glob: "api/**"
    scope: "api"
    required: ask

  - glob: "docs/architecture/**"
    scope: "architecture-records"
    required: false
```

This keeps the rule scalable. Every project can define what paths are architecture-sensitive.

### 2. Architecture impact declaration

Each PR/work item should include an explicit architecture-impact declaration. During docs-first phase, the declaration can live in one of:

```text
docs/work/<date>-<slug>/architecture-impact.md
docs/work/<date>-<slug>/decisions.md
docs/architecture/**
PR template section
```

Recommended file template:

```markdown
# Architecture Impact

```yaml
architecture_impact: yes | no | unknown
changed_scopes:
  - subsystem:cart
  - subsystem:pricing
records_updated:
  - AN-YYYYMMDD-slug
  - PD-YYYYMMDD-slug
open_questions:
  - AQ-YYYYMMDD-slug
source_evidence:
  - path: path/to/file
```

## Rationale

Explain why architecture changed, why it did not change, or what remains unknown.
```

### 3. Lefthook pre-commit adapter: fast guard

Add to `lefthook.yml`:

```yaml
pre-commit:
  commands:
    architecture-impact:
      run: forge architecture impact --mode pre-commit
      stage_fixed: false
      tags: architecture
```

Fast behavior:

1. Read staged files.
2. Match changed files against `.forge/architecture-impact.yaml`.
3. If no sensitive files changed, pass.
4. If sensitive files changed, require one of:
   - staged architecture record under `docs/architecture/**`,
   - staged `docs/PROJECT_DESIGN.md` update,
   - staged work-folder `architecture-impact.md`,
   - explicit no-impact declaration with rationale.
5. If missing, block with a helpful message and suggested command/template.

### 4. Lefthook pre-push adapter: stronger validation

Add to pre-push:

```yaml
pre-push:
  commands:
    architecture-check:
      run: forge architecture impact --mode pre-push
      tags: architecture
```

Stronger behavior:

- validate architecture record IDs,
- validate source paths exist,
- detect duplicate active topic/scope records,
- check `PROJECT_DESIGN.md` links `docs/architecture/index.md`,
- warn/block unresolved `architecture_impact: unknown` depending on config.

### 5. CI required check

Local hooks are not enough because humans can use `--no-verify` and agents may have incomplete hook support. Add CI as the merge gate:

```text
bun run check
  -> node scripts/validate.js
  -> forge architecture impact --mode ci
```

CI should fail if architecture-sensitive changes lack records/declarations, if an `architecture_impact: unknown` declaration violates branch/project policy, if an audited bypass record is missing/invalid, or if hook adapter policy has drifted from the Forge check engine. Branch protection should require this check.

### 6. Agent-native hooks: preferred UX

Agent harness hooks should be the primary interactive mechanism where supported:

- before sensitive edits, require architecture orientation or an architecture-impact check;
- after edits, ask for an impact declaration while the agent still knows why files changed;
- before task completion or PR creation, block missing architecture records/questions/conflicts;
- emit brownfield-friendly prompts such as `observed`, `unknown`, or `architecture_question` instead of forcing fake certainty.

Harness examples:

- **Hermes:** project instructions/skills plus future hook adapters call `forge architecture impact --mode agent`.
- **Claude/Cursor PreToolUse:** before edits to sensitive paths, remind/block unless orient/architecture records were checked.
- **Codex/other terminal agents:** use project instructions and command wrappers to require impact checks before sensitive edits and before completion.
- **MCP later:** expose `architecture.impact` as a tool agents can call before modifying files.

Do not rely only on agent hooks. Harness support differs and can be bypassed. CI/Kernel gates remain the enforcement boundary.

### 7. Agent no-verify policy

Agents must not bypass Forge workflow gates by default. Forbidden unless the user explicitly authorizes a specific bypass with a reason:

```text
git commit --no-verify
git push --no-verify
HUSKY=0 git commit
LEFTHOOK=0 git commit
disabling/removing hook shims or changing core.hooksPath to bypass Forge checks
script-mediated hook bypasses
```

A future audited bypass flow may allow:

```bash
FORGE_ALLOW_NO_VERIFY=<work-item-id> git commit --no-verify
```

But the bypass must be an audited Forge event, not just chat text or an environment variable. Proposed lifecycle:

1. User explicitly authorizes one bypass action for one work item/check.
2. Agent records it with a Forge command such as `forge bypass request --work-item <id> --check <name> --reason <text>`.
3. Forge records actor, harness, worktree, command, skipped checks, reason, timestamp, expiry, and follow-up validation plan.
4. Agent command guards reject `--no-verify`, `HUSKY=0`, `LEFTHOOK=0`, `git -c core.hooksPath=...`, hook removal, and script-mediated bypasses unless a matching unexpired bypass record exists.
5. CI validates the bypass record and still runs required policy checks.
6. Future Kernel stores accepted bypass events with idempotency/revision metadata.

This is an emergency escape hatch, not a successful bypass of project policy.

## User experience

If a developer changes `lib/knowledge/store.js` without architecture capture, the hook should say:

```text
Architecture impact required

Changed file:
  lib/knowledge/store.js
Matched scope:
  subsystem:knowledge
Relevant topics:
  knowledge.storage.boundary
  knowledge.truth-model

Add one of:
  docs/work/<date>-<slug>/architecture-impact.md
  docs/architecture/subsystems/knowledge.md
  docs/architecture/notes/AN-YYYYMMDD-<slug>.md
  docs/PROJECT_DESIGN.md update if accepted direction changed

If no architecture changed, add architecture-impact.md with:
  architecture_impact: no
  rationale: <why this is implementation-only>
```

This makes the mechanism educational, not just blocking.

## Brownfield mode

For existing projects, use `unknown`/`observed` instead of forcing final truth:

```yaml
architecture_impact: unknown
open_questions:
  - AQ-20260608-pricing-authority-unclear
```

or:

```yaml
record_type: architecture_note
status: observed
confidence: medium
source:
  - path: services/pricing/index.ts
```

The hook should accept partial discovery if it creates a record. This gives brownfield projects immediate value. `architecture_impact: unknown` is allowed only with an `architecture_question` or `architecture_conflict`, owner/review target, and source evidence; CI may allow or block unknowns based on project configuration.

## Scaling model

For large projects, hooks should not scan every doc deeply on each commit. Use phases:

1. **Fast path:** staged file matching + presence of architecture-impact declaration.
2. **Pre-push:** validate changed/linked architecture records only.
3. **CI:** full registry validation.
4. **KnowledgeStore later:** indexed lookups by path/topic/scope.
5. **Server/Kernel later:** accepted decisions/facts/conflicts are validated as authority writes.

This avoids 10,000-line doc scans on every local commit.

## Mandatory policy

Hook-backed rule:

```text
Architecture-sensitive change without architecture-impact declaration = block.
Architecture changed/discovered without architecture record = block.
No-impact is allowed, but must be explicit and reviewable.
Unknown is allowed for brownfield, but must create a question/conflict record with owner/review target and source evidence.
```

## Implementation slices

1. Add `.forge/architecture-impact.yaml` default manifest.
2. Add Forge-owned `forge architecture impact` / `forge architecture check` policy engine, with a temporary `scripts/architecture-impact-check.js` shim only if needed during CLI rollout.
3. Add agent-native hook/instruction adapters as the primary UX for Hermes, Claude Code, Cursor, Codex, and generic terminal agents.
4. Add `forge hooks doctor/install/sync` so worktrees, containers, and agent sandboxes can detect missing adapters instead of silently losing checks.
5. Wire Lefthook pre-commit and pre-push as a repo-local adapter, not the source of truth.
6. Add no-verify command guard policy for agents, including explicit/audited bypass semantics.
7. Add fixtures/tests for sensitive path + no declaration, no-impact declaration, architecture record update, brownfield unknown question, missing Lefthook install, and no-verify attempts.
8. Add CI/`bun run check` integration as the required final gate.
9. Add future KnowledgeStore-backed `forge architecture impact` retrieval.

## Decision

Use agent-native hooks as the preferred capture experience, Forge CLI checks as the shared policy engine, Lefthook as an optional Git adapter, CI as the mandatory merge gate, future Kernel events as durable authority, and KnowledgeStore as the verbatim/provenance index plus proposal/retrieval layer.
