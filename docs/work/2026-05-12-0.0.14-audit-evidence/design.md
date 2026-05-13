# Feature: 0.0.14 audit evidence persistence

Date: 2026-05-12
Status: Planned
Issue: forge-besw.20
Related design-only issue: forge-besw.27

## Purpose

Persist evidence for `/dev` and future `/build` subagent calls through Beads audit entries so implementer, spec reviewer, and quality reviewer activity is visible to audit, evaluation, and downstream mining flows.

## Verified Context

- `origin/HEAD` is `master`, and the worktree was created at `origin/master` commit `cda53e886bd52b34c63e52fe64d804153161c648`.
- `lib/commands/dev.js` currently owns the executable `/dev` helper surface and exports `executeDev`, decision routing, and task completion helpers.
- No executable `/build` command exists in `lib/commands` on this branch; `/build` support will therefore be a reusable audit helper plus documented event shape rather than a new command.
- `bd audit record --help` supports `--kind`, `--issue-id`, `--model`, `--prompt`, `--response`, `--tool-name`, `--exit-code`, `--error`, and `--stdin`.
- `bd audit label --help` supports `bd audit label <entry-id> --label <value> --reason <reason>`.
- Current `bd audit --help` does not expose `verify` or `--meta-json`; `bd audit verify --json` prints audit help instead of verifying a hash chain in this environment.

## Success Criteria

1. Forge has a reusable audit evidence module for subagent invocation events.
2. `/dev` can emit implementer, spec reviewer, and quality reviewer audit events without leaking raw secrets.
3. Reviewer PASS/FAIL verdicts map to `bd audit label <entry-id> --label good|bad` when the label command is available.
4. Tests cover event shape, redaction, label command behavior, and `.forge/log.jsonl` fallback metadata.
5. The PR body states the fallback decision and the exact validation commands run.

## Out of Scope

- No 0.0.13 config, L1 rails, protected paths, or options API changes.
- No new `/build` command unless a command already exists to wire.
- No replacement for Beads as source of truth.
- No separate hash-chain implementation to compete with `.beads/interactions.jsonl`.

## Approach Selected

Add `lib/audit-evidence.js` as a narrow adapter around `bd audit record` and `bd audit label`. The adapter will build a redaction-safe `llm_call` payload from a normalized subagent event, record it through Beads, and optionally append minimal metadata to `.forge/log.jsonl` only when richer upstream metadata support such as `--meta-json` is unavailable.

`/dev` will call the adapter through exported helper functions so the current command remains testable and the same event contract can be reused by a future `/build` command without adding rails or options.

## Event Shape

Normalized event input:

```json
{
  "command": "dev",
  "issueId": "forge-besw.20",
  "role": "implementer|spec_reviewer|quality_reviewer",
  "phase": "RED|GREEN|REFACTOR|SPEC|QUALITY",
  "taskId": "task-1",
  "taskTitle": "Audit evidence helper",
  "model": "unknown",
  "prompt": "redacted prompt summary",
  "response": "redacted response summary",
  "verdict": "PASS|FAIL|UNKNOWN",
  "metadata": {}
}
```

Beads record command:

```bash
bd audit record --json --kind llm_call --issue-id <issue> --model <model> --prompt <redacted-json> --response <redacted-json>
```

Reviewer labeling:

```bash
bd audit label <entry-id> --label good|bad --reason "<role> verdict: PASS|FAIL"
```

Fallback metadata line:

```json
{"kind":"forge.auditEvidence","beadsEntryId":"int-...","sourceOfTruth":"beads","metadata":{}}
```

## Fallback Decision

Current upstream `bd audit` does not expose `--meta-json`. This PR will implement a minimal `.forge/log.jsonl` metadata fallback that references the Beads audit entry ID. The fallback is supplemental only; Beads remains the source of truth for interaction records and labels.

## Validation Plan

- `bun test test/audit-evidence.test.js`
- `bun test test/commands/dev.test.js test/audit-evidence.test.js`
- `bun run typecheck`
- `bun run lint`
- `bun run check`
- Manual audit CLI checks for `bd audit record`, `bd audit label`, and current `bd audit verify` availability.
