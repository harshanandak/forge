# Skill Eval Loop — Task List

**Design doc**: [2026-03-14-skill-eval-loop-design.md](2026-03-14-skill-eval-loop-design.md)
**Beads**: forge-1jx
**Branch**: feat/skill-eval-loop

---

## Task 1: Create evals.json for parallel-web-search

**File(s)**: `skills/parallel-web-search/evals/evals.json`
**What to implement**: Write 12-15 trigger eval queries. Include:
- 6-8 should-trigger queries (web search, find sources, look up facts, current news)
- 4-5 should-NOT-trigger queries that test disambiguation against sibling skills:
  - `deep-research` queries (market analysis, comprehensive reports)
  - `web-extract` queries (scrape this URL, extract from page)
  - `data-enrichment` queries (enrich company data, CRM lookup)
- 2-3 generic should-NOT-trigger queries (code review, fix this bug, etc.)

**Format**: JSON array of `{"query": "...", "should_trigger": true/false}`
**Commit**: `feat(evals): add trigger eval set for parallel-web-search`

---

## Task 2: Create evals.json for parallel-deep-research

**File(s)**: `skills/parallel-deep-research/evals/evals.json`
**What to implement**: Write 12-15 trigger eval queries. Include:
- 6-8 should-trigger queries (deep analysis, market research, comprehensive report, multi-source synthesis)
- 4-5 should-NOT-trigger disambiguation queries:
  - `web-search` queries (quick lookup, find a source, current price)
  - `web-extract` queries (scrape URL, extract pricing page)
  - `data-enrichment` queries (enrich entity, structured data)
- 2-3 generic should-NOT-trigger queries

**Format**: JSON array of `{"query": "...", "should_trigger": true/false}`
**Commit**: `feat(evals): add trigger eval set for parallel-deep-research`

---

## Task 3: Create evals.json for parallel-web-extract

**File(s)**: `skills/parallel-web-extract/evals/evals.json`
**What to implement**: Write 12-15 trigger eval queries. Include:
- 6-8 should-trigger queries (scrape URL, extract content from page, get pricing from URL, pull docs from site)
- 4-5 should-NOT-trigger disambiguation queries:
  - `web-search` queries (search for X, find sources)
  - `deep-research` queries (analyze market, research report)
  - `data-enrichment` queries (enrich company)
- 2-3 generic should-NOT-trigger queries

**Format**: JSON array of `{"query": "...", "should_trigger": true/false}`
**Commit**: `feat(evals): add trigger eval set for parallel-web-extract`

---

## Task 4: Create evals.json for parallel-data-enrichment

**File(s)**: `skills/parallel-data-enrichment/evals/evals.json`
**What to implement**: Write 12-15 trigger eval queries. Include:
- 6-8 should-trigger queries (enrich company data, CRM enrichment, lead qualification, entity lookup, structured data about company)
- 4-5 should-NOT-trigger disambiguation queries:
  - `web-search` queries (search for X, find news)
  - `deep-research` queries (market analysis, comprehensive report)
  - `web-extract` queries (scrape this URL)
- 2-3 generic should-NOT-trigger queries

**Format**: JSON array of `{"query": "...", "should_trigger": true/false}`
**Commit**: `feat(evals): add trigger eval set for parallel-data-enrichment`

---

## Task 5: Create evals.json for citation-standards

**File(s)**: `skills/citation-standards/evals/evals.json`
**What to implement**: Write 10-12 trigger eval queries. Include:
- 5-6 should-trigger queries (write research doc, add citations, format sources, reference external source in docs/research/)
- 5-6 should-NOT-trigger queries (write code, fix bug, run tests, deploy, general web search, scrape URL)

**Format**: JSON array of `{"query": "...", "should_trigger": true/false}`
**Commit**: `feat(evals): add trigger eval set for citation-standards`

---

## Task 6: Create evals.json for sonarcloud-analysis

**File(s)**: `skills/sonarcloud-analysis/evals/evals.json`
**What to implement**: Write 10-12 trigger eval queries. Include:
- 5-6 should-trigger queries (check code quality, SonarCloud issues, security vulnerabilities, test coverage, quality gate status)
- 5-6 should-NOT-trigger queries (write code, deploy, web search, research, format citations)

**Format**: JSON array of `{"query": "...", "should_trigger": true/false}`
**Commit**: `feat(evals): add trigger eval set for sonarcloud-analysis`

---

## Task 7: Run skill-creator eval loop — Batch 1a (web-search + web-extract)

**What to do**: Invoke the `skill-creator` skill for trigger accuracy optimization on:
1. `parallel-web-search`
2. `parallel-web-extract`

Run 2 in parallel. The skill-creator handles: baseline measurement → train/test split → description improvement → re-eval → up to 5 iterations → benchmark generation.

**Expected output**: Before/after trigger rates, improved descriptions (if needed), benchmark reports.
**Commit**: `feat(skills): optimize trigger descriptions for web-search and web-extract`

---

## Task 8: Run skill-creator eval loop — Batch 1b (deep-research + data-enrichment)

**What to do**: Same as Task 7 but for:
1. `parallel-deep-research`
2. `parallel-data-enrichment`

**Expected output**: Before/after trigger rates, improved descriptions, benchmark reports.
**Commit**: `feat(skills): optimize trigger descriptions for deep-research and data-enrichment`

---

## Task 9: Run skill-creator eval loop — Batch 2 (citation-standards + sonarcloud-analysis)

**What to do**: Same as Task 7 but for:
1. `citation-standards`
2. `sonarcloud-analysis`

**Expected output**: Before/after trigger rates, improved descriptions, benchmark reports.
**Commit**: `feat(skills): optimize trigger descriptions for citation-standards and sonarcloud-analysis`

---

## Task 10: Cross-skill regression check

**What to do**: After all descriptions are optimized, run a final cross-skill check:
- Take the disambiguation queries from Tasks 1-4 (should-NOT-trigger for sibling skills)
- Verify the optimized descriptions don't cause false-positive triggers on sibling skills
- If regressions found: **PAUSE and ask user** (per ambiguity policy)

**Expected output**: Cross-skill trigger matrix showing each query vs. each Parallel AI skill.
**Commit**: `docs: add cross-skill trigger matrix`

---

## Task 11: Commit improved descriptions and before/after summary

**What to do**:
- Commit any SKILL.md description changes from the eval loops
- Create a summary document with before/after trigger rates for all 6 skills
- Save to `docs/plans/2026-03-14-skill-eval-loop-results.md`

**Commit**: `docs: add skill eval loop results summary`

---

## Ordering rationale

1. Tasks 1-6 (eval sets) are independent — can be parallelized
2. Tasks 7-9 (eval loops) depend on eval sets and run in batches of 2
3. Task 10 (cross-check) depends on all loops completing
4. Task 11 (summary) depends on everything
