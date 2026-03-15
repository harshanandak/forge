# Skill Eval Loop — Design Doc

| Field | Value |
|-------|-------|
| Feature | skill-eval-loop |
| Date | 2026-03-14 |
| Status | Draft |
| Beads | forge-1jx |

## Purpose

Optimize trigger accuracy for all 6 skills in `skills/` using the installed `skill-creator` plugin. Ensure each skill fires for the right user queries and doesn't fire for wrong ones — especially important for the 4 Parallel AI skills that share similar domains.

## Success Criteria

1. All 6 skills have `evals.json` files with 10-15 queries each (mix of should-trigger and should-not-trigger)
2. Cross-skill disambiguation queries included for the 4 Parallel AI skills
3. Baseline trigger rates captured (before)
4. `skill-creator` eval loop run on each skill (up to 5 iterations)
5. After trigger rates captured with before/after comparison
6. Improved descriptions committed back to each skill's SKILL.md

## Out of Scope

- Full quality eval (end-to-end execution with output grading) — requires API keys, expensive, separate effort
- Creating new skills
- Modifying skill logic/implementation beyond the description field
- Changes to the skill-creator plugin itself

## Approach Selected

Use the `skill-creator` skill directly. It handles:
- Trigger accuracy measurement via `run_eval.py` (uses `claude -p` subprocess with stream event detection)
- Train/test split (60% train / 40% test holdout, stratified by should_trigger)
- Description improvement via Claude with extended thinking
- Iterative loop (up to 5 iterations per skill)
- Benchmark generation via `aggregate_benchmark.py`
- Interactive HTML review UI

### Execution batching (Option C selected)
- **Batch 1**: 4 Parallel AI skills (`web-search`, `deep-research`, `web-extract`, `data-enrichment`) — run 2 at a time, shared cross-skill disambiguation context
- **Batch 2**: `citation-standards` + `sonarcloud-analysis` — run together

### Eval set design
- 10-15 queries per skill (moderate coverage)
- Each includes should-trigger and should-NOT-trigger queries
- Parallel AI skills include cross-skill disambiguation queries (e.g., "scrape this URL" → should trigger `web-extract`, should NOT trigger `web-search`)

## Constraints

- `claude -p` subprocess calls: 30s timeout per query, 3 runs per query
- Cross-skill disambiguation is critical for the 4 Parallel AI skills
- Resource-aware batching: max 2-3 concurrent eval loops

## Edge Cases

- **Cross-skill overlap**: A query like "find information about X" could legitimately trigger both `web-search` and `deep-research`. Eval sets must have clear intent boundaries.
- **Description changes causing regressions**: Improving one skill's trigger accuracy may hurt another's if descriptions become too similar. Monitor cross-skill results.
- **Already-optimal descriptions**: Some skills may already have high trigger accuracy. The loop will exit early if all train queries pass.

## Ambiguity Policy

**(B) Pause and ask for input** — especially if a description change hurts one skill's trigger rate while improving another. Cross-skill trade-offs require human judgment.

## Technical Research

### skill-creator capabilities (verified from plugin source)
- `run_eval.py`: Single eval run with trigger rate measurement
- `run_loop.py`: Full optimization loop with train/test split, max 5 iterations
- `aggregate_benchmark.py`: Benchmark stats (mean, stddev, delta)
- `improve_description.py`: Description improvement via Claude with extended thinking
- `eval-viewer/generate_review.py`: Interactive HTML review UI

### evals.json schema (from plugin references/schemas.md)
```json
{
  "skill_name": "skill-name",
  "evals": [
    {
      "id": "unique-id",
      "prompt": "user query text",
      "should_trigger": true,
      "expected_output": "optional expected output",
      "files": [],
      "expectations": []
    }
  ]
}
```

### OWASP Top 10 Analysis

| Category | Applies? | Notes |
|----------|----------|-------|
| A01: Broken Access Control | No | No auth/access control involved |
| A02: Cryptographic Failures | No | No crypto operations |
| A03: Injection | Low | `claude -p` subprocess calls use controlled inputs from evals.json |
| A04: Insecure Design | No | Eval-only, no production features |
| A05: Security Misconfiguration | No | Local tool usage |
| A06: Vulnerable Components | No | Using installed plugin as-is |
| A07: Auth Failures | No | No authentication |
| A08: Data Integrity Failures | No | Local file operations |
| A09: Logging Failures | No | Eval results are logged by design |
| A10: SSRF | No | No server-side requests |

Risk surface: Minimal. This is a local dev-time optimization task.

### TDD Test Scenarios

This feature is eval-driven rather than code-driven (we're creating eval sets, not writing application code). The "tests" are the evals.json files themselves. However, we can validate:

1. **Happy path**: Each evals.json is valid against the schema and contains 10-15 queries with correct should_trigger values
2. **Cross-skill disambiguation**: Queries that should trigger skill A explicitly should-NOT-trigger for overlapping skill B
3. **Balanced split**: Each eval set has a reasonable mix of should-trigger (true/false) for stratified train/test split

### DRY Check

No existing eval sets or benchmark results found in the project. This is greenfield work for eval infrastructure.
