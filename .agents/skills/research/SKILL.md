---
name: research
description: >
  Forge RESEARCH — a first-class, freely-invocable investigation skill any agent can call
  standalone OR mid-workflow (mid-/dev, mid-/validate, mid-/plan), not a plan-only stage. Use
  it to verify/fact-check a claim against primary sources; web-search best practices, gotchas,
  and docs; find better options/patterns and weigh trade-offs; see both sides (steelman the
  right way AND red-team the wrong way); pull inspiration from stronger sources; and run the
  /plan Phase 2 bundle (web research + OWASP Top 10 + DRY/blast-radius codebase exploration +
  3+ TDD scenarios) under `## Technical Research`. Trigger on "verify/fact-check this",
  "research X",
  "find a better way/option", "is this true", "get inspiration", "run the research phase", or
  mid-task "investigate before I decide". Pick over siblings: `parallel-deep-research` for a
  heavyweight EXTERNAL market/competitive report (paid Parallel AI); `plan` for the full plan
  stage (brainstorm + tasks); `dev` or `validate` to implement or scan rather than investigate.
allowed-tools: Bash, Read, Write, Grep, Glob, WebSearch, WebFetch
---

Investigate anything, from anywhere: verify a claim, search the web, find better options, pull
inspiration from stronger sources, weigh perspectives, and package technical research for a plan.

# Research

`/research` is a **first-class capability**, not a stage. Any agent may invoke it at any point —
standalone, or in the middle of another skill — whenever a question needs evidence before a
decision. It is broader than `parallel-deep-research`: that sibling is a heavyweight external
market/industry report; this skill is your everyday "go find out and come back with evidence."

## When to use it

- **Verify a claim** — "is this API deprecated?", "does this library support X?", "is this the
  current best practice?" Confirm or refute against primary sources.
- **Find a better way / better options** — enumerate real alternatives and compare trade-offs.
- **Web research** — best practices, gotchas, current docs, changelogs, version differences.
- **Inspiration / prior art** — pull stronger plans, patterns, and reference implementations
  from better sources than memory.
- **Multi-perspective** — see it done the right way AND the wrong way; steelman and red-team.
- **Codebase research** — DRY, blast-radius, reusable patterns already in the repo.
- **/plan Phase 2 bundle** — the packaged deliverable `plan` delegates to (see "Plan bundle").

## How to invoke

Standalone (user asks directly):

```bash
/research <question or claim>
```

From inside another skill or agent — call the Skill tool mid-flow:

```
Skill("research")   # then hand it the specific question + why you're asking
```

Always give research: (1) the concrete question or claim, (2) the decision it feeds, and
(3) any constraints (stack, versions, repo area). Research returns **evidence, not opinion**:
cited findings, and — when a caller needs it — a recommendation with the trade-offs shown.

---

## Modes

Pick the mode(s) that fit the question. Most investigations combine two or three.

### Mode A — Verify / fact-check a claim

1. State the claim in one sentence and what would confirm vs refute it.
2. Pull **primary sources** first (official docs, source code, specs, changelogs) via WebSearch
   → WebFetch. Secondary sources (blogs, SO) only corroborate.
3. Adversarially check: look for the counter-evidence, not just confirmation.
4. Return: `CONFIRMED / REFUTED / MIXED / UNKNOWN` + the cited evidence + a one-line reason.

Never answer a factual claim from memory. Fetch the source, cite it (URL + the line that
settles it). "I'm confident" is not evidence.

### Mode B — Explore options / find a better way

1. Frame the decision and the constraints (perf, safety, complexity, lock-in, maturity).
2. Enumerate 2–4 concrete options — include the "boring/obvious" one and at least one you did
   not start with.
3. For each: what it is, when it wins, when it loses, adoption/maintenance signal.
4. Recommend one, with the trade-off that decides it. Show the runners-up so the caller can
   overrule.

### Mode C — Web search (quick → deep)

Depth ladder — escalate only as needed:

| Depth | Tool | Use for |
|-------|------|---------|
| Quick | built-in `WebSearch` / `WebFetch` | a fact, a doc page, one gotcha |
| Deep, cited | `Skill("deep-research")` | multi-source, adversarially verified report |
| External report | `Skill("parallel-deep-research")` | market/competitive/industry landscape (paid) |

Search terms that work: `"[stack] [feature] best practices [year]"`,
`"[library] [feature] pitfalls"`, `"[approach] known issues"`. Prefer official docs via
Context7/grep.app MCP when available for library/API questions.

### Mode D — Inspiration / better plans from better sources

Look outward before inventing: canonical implementations, well-run OSS repos, design docs,
RFCs. Pull the *shape* of a stronger solution and adapt it — don't copy blindly. Note the
source so the plan can cite where the idea came from.

### Mode E — Multi-perspective (steelman + red-team)

For anything consequential, gather both:

- **Steelman (the right way)** — the strongest case for the approach and how experts do it.
- **Red-team (the wrong way)** — failure modes, anti-patterns, "why teams regret this",
  security and edge-case traps.

Return both columns so the decision is made with eyes open, not just the happy path.

### Mode F — Codebase research (DRY + blast-radius)

Use actual search tools — never rely on memory:

```
Grep("<function or concept>")   # existing implementations to reuse
Glob("**/*.<ext>")              # narrow to affected file types
Read(<match>)                   # inspect matches in context
```

- **DRY**: if a match exists, prefer "extend existing <file>:<line>" over "create new".
- **Blast-radius** (for remove/rename/replace): grep the entire repo (exact + case-insensitive
  + `Glob("**/*<thing>*")`), then list every hit — including `package.json`, install/setup
  scripts, CI workflows, agent config, and docs — so nothing is missed.

For broad multi-location sweeps, spawn the `Explore` agent and keep only its summary.

---

## Plan bundle (what `/plan` Phase 2 delegates to)

When invoked by `/plan` for a feature's design doc, run the full technical bundle and append it
under a `## Technical Research` section in `docs/work/YYYY-MM-DD-<slug>/plan.md`:

1. **Web research** (Mode C) — best practices, gotchas, patterns for the chosen approach.
2. **OWASP Top 10 pass** — for each relevant category (A01–A10): the risk, whether it applies,
   and the planned mitigation.
3. **DRY check** (Mode F) — reusable existing implementations.
4. **Blast-radius search** (Mode F) — required for any remove/rename/replace; every reference
   captured for the task list.
5. **Codebase exploration** — similar patterns, affected files, test infra to leverage.
6. **TDD scenarios** — at minimum 3: happy path, error/failure path, and one Phase-1 edge case.

The caller's HARD-GATE (in `/plan`) still verifies these outputs exist — research produces
them; the gate enforces them. Do not treat delegation as a way to skip the gate.

---

## Invoked mid-flow (examples)

- **Mid-/validate** — a security or type failure surfaces and the fix is unclear: call
  `Skill("research")` to verify the correct API/pattern against primary sources before editing
  (feeds the D2 root-cause trace), then return to validation.
- **Mid-/dev** — a decision gate fires on a spec gap: research the options (Mode B) and current
  best practice (Mode C) so the decision is evidence-backed, then log the decision and continue.
- **Mid-/plan** — an approach looks shaky during brainstorming: research alternatives and
  red-team the front-runner (Mode E) before committing the design.
- **Any agent, any time** — "before I decide, let me check" is always a valid reason to invoke.

## Output contract

- Cite every non-obvious claim (URL or `file:line`) — findings without sources are opinions.
- Lead with the answer/recommendation, then the evidence, then the runners-up.
- When invoked by `/plan`, append to the design doc's `## Technical Research` section (not a
  separate file). When invoked mid-flow, return a concise evidence-backed answer to the caller.
- Flag what you could NOT verify as `UNKNOWN` rather than guessing.

## Integration with workflow

```
Utility: /status  -> Understand current context before starting

Default template:
  /plan      -> Optional default planner; delegates its Phase 2 technical research to /research
  /dev       -> Implement each task with subagent-driven TDD (may call /research at a spec gap)
  /validate  -> Type check, lint, tests, security (may call /research to root-cause a failure)
  /ship      -> Push + create PR
  /review    -> Address PR feedback
  /verify    -> Post-merge health check

Research is callable standalone or from any of the above — it is a capability, not a gate.
```

## Tips

- **Evidence beats memory** — always fetch and cite; never settle a fact from recall.
- **Escalate depth deliberately** — quick WebSearch first; reach for `deep-research` or
  `parallel-deep-research` only when a single search can't answer it.
- **Both perspectives** — for consequential calls, always red-team, not just steelman.
- **Delegation ≠ skipping gates** — when `/plan` delegates the bundle, its HARD-GATE still
  checks OWASP + 3 TDD scenarios + blast-radius are present.
