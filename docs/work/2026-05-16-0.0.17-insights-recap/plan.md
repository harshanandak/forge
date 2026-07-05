# 0.0.17 Insights And Recap

## Scope

Cover:
- `forge-besw.12`: insights from review and evidence patterns
- `forge-1gry`: pattern detector plus skill suggestion UX
- `forge-5q7s`: recap / personal digest

Do not touch:
- upgrade safety
- lockfile/trust policy
- patch intent internals
- team dashboard or issue sync surfaces

## Verified Baseline

- `master` fast-forwarded to `origin/master` at `5519261e1c8ee449715eeacc376304a898e056bb`.
- PR #164 `0.0.17 planning and memory loop` is merged at `5fc9a3302bfac38f302febe9fa8c4b41f7d5f906` and is an ancestor of local and remote `master`.
- PR #165 `0.0.16 upgrade safety foundation` is merged at `5519261e1c8ee449715eeacc376304a898e056bb`.

## Inputs

- `.beads/interactions.jsonl` is the primary interaction source. The issue text explicitly says not to add a separate agent log writer.
- `.beads/issues.jsonl` provides issue status, labels, closed reasons, and recent work context for recap.
- `.forge/log.jsonl` and `.forge/audit.log` may be read when present, but absence is not an error.
- `lib/memory/typed-api.js` is used to persist accept/reject decisions, keeping Beads-backed memory as the write path.

## CLI Shape

- `forge insights [--limit N] [--min-count N] [--json] [--since YYYY-MM-DD]`
- `forge insights accept <candidate-id> [--note text]`
- `forge insights reject <candidate-id> [--note text]`
- `forge recap [--limit N] [--json] [--since YYYY-MM-DD]`

`forge insights --review-feedback` remains accepted as a compatibility alias, but the output explains that the MVP mines Beads interactions and issue evidence rather than external review-provider comments.

## Detection

Patterns are conservative and evidence-first:
- interaction field-change patterns by field/value/reason family
- recurring issue theme tokens from recent issue titles and descriptions
- audit event kind counts when Forge audit logs exist

Candidates are ranked by frequency, source diversity, and evidence count. Low-signal history returns a clear "no strong patterns" result rather than inventing a suggestion.

## Skill Suggestions

Suggestions are pending candidates only. Accept/reject records a typed memory decision with provenance and Beads issue references. Accept does not install arbitrary executable code or mutate trust/lock policy.

## Recap

Recap output summarizes:
- recent issue activity
- closed/review outcomes found in interactions
- top patterns and candidate next steps
- evidence availability and limitations

## Limitations

- The insights command infers recurring local workflow signals, not correctness, reviewer intent, or team-wide productivity.
- Missing Forge audit logs or sparse `.beads/interactions.jsonl` limits confidence.
- Accepting a suggestion records a decision and next-step text; it does not auto-publish skills into trusted runtime surfaces.
