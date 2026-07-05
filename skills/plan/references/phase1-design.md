# Plan Phase 1 — Design Intent / brainstorming (reference)

## Phase 1: Design Intent (Brainstorming)

**Goal**: Capture WHAT to build — purpose, constraints, success criteria, edge cases, approach.

### Step 0: Dependency ripple check (advisory)

Before exploring context or asking questions, check for potential conflicts with in-flight work:

```bash
# If a Forge issue ID is known (e.g., from /status or forge ready):
# Advisory only — runs when the dep-guard tooling is present; a failure is non-fatal.
if [ -f scripts/dep-guard.sh ]; then
  bash scripts/dep-guard.sh check-ripple <forge-issue-id> || echo "dep-guard ripple check skipped (advisory)"
fi

# If no issue exists yet (first-time plan):
forge list --status=open,in_progress
```

Review the output. If overlaps are detected:
- Consider whether the overlapping issue should be a dependency
- Note any shared areas for the design Q&A
- This check is **advisory only** — always proceed to Step 1 regardless of findings

#### Ripple Analyst Agent (spawned when contract overlaps found)

When `check-ripple` detects overlapping issues AND contract metadata is available, spawn a Ripple Analyst subagent with this prompt:

**Input to agent**:
- Current issue's contract changes (from `extract-contracts` output)
- Consumer code snippets (from `find-consumers` output for each changed contract)
- Overlapping issue's title, description, and contract metadata

**Agent instructions**:
1. For each overlapping contract, imagine 2-3 concrete break scenarios:
   - "If [contract X] changes [specific behavior], then [consumer Y] will [specific failure]"
2. Rate overall impact as one of:
   - **NONE**: No real conflict despite keyword overlap
   - **LOW**: Consumers need trivial adjustment (add parameter, rename call)
   - **HIGH**: Consumer needs significant rework (parsing logic, data handling changes)
   - **CRITICAL**: Consumer is in an active in_progress issue's task list
3. **When uncertain, default to HIGH** — conservative over permissive
4. Recommend one action:
   - Add dependency (`forge issue dep add <source> <target>`)
   - Coordinate with other issue's developer
   - Scope down current feature to avoid overlap
   - Proceed as-is (no real conflict)

**Output format**:
```
Impact: [NONE|LOW|HIGH|CRITICAL]
Confidence: [high|medium|low]

Break scenarios:
1. [scenario description]
2. [scenario description]

Recommendation: [action]
Reason: [why this action]
```

This agent is advisory only. The developer always makes the final decision.

### Step 1: Explore project context

Before asking any questions, read relevant files:
- Recent commits related to this area
- Existing code in affected modules
- Any related docs, tests, or prior research

### Step 2: Ask clarifying questions — one at a time

Ask each question in sequence. Wait for user response. Use multiple choice where possible.

Questions to cover (adapt to feature, don't ask mechanical copies):
1. **Purpose** — What problem does this solve? Who benefits?
2. **Constraints** — What must this NOT do? What are the hard limits?
3. **Success criteria** — How will we know it's done? What is the minimum viable result?
4. **Edge cases** — What happens when [key dependency] fails / [input] is missing / [state] is ambiguous?
5. **Technical preferences** — Library A or B? Pattern X or Y? (when real options exist)

### Step 3: Propose approaches

Propose 2-3 concrete approaches with:
- Trade-offs (speed vs safety, complexity vs flexibility)
- A clear recommendation with reasoning
- Get user approval on the chosen approach

### Step 4: Write design doc

Save to `docs/work/YYYY-MM-DD-<slug>/design.md` with these sections:
- **Feature**: slug, date, status
- **Purpose**: what problem it solves
- **Success criteria**: measurable, specific
- **Out of scope**: explicit boundaries
- **Approach selected**: which option and why
- **Constraints**: hard limits
- **Edge cases**: decisions made during Q&A
- **Ambiguity policy**: Use 7-dimension rubric scoring per /dev decision gate. >= 80% confidence: proceed and document. < 80%: stop and ask.

Commit the design doc:
```bash
git add docs/work/YYYY-MM-DD-<slug>/design.md
git commit -m "docs: add design doc for <slug>"
```

---

**--strategic flag** (for major architecture changes):

After committing the design doc, push to a proposal branch and open PR:
```bash
git checkout -b feat/<slug>-proposal
git push -u origin feat/<slug>-proposal
gh pr create --title "Design: <feature-name>" \
  --body "Design doc for review. See docs/work/YYYY-MM-DD-<slug>/design.md"
```

**STOP here.** Present the PR URL. Wait for the user to merge the proposal PR.
After merge, run `/plan <slug> --continue` to proceed to Phase 2 + 3.

---

```
<HARD-GATE: Phase 1 exit>
Do NOT begin Phase 2 (web research) until:
1. User has approved the design in this session OR external-planner evidence satisfies the `/dev` entry contract from D34
2. Design doc exists at docs/work/YYYY-MM-DD-<slug>/design.md
3. Design doc includes: success criteria, edge cases, out-of-scope, ambiguity policy
4. Design doc is committed to git
</HARD-GATE>
```

---
