# Universal PR Review Handler — Research & Design

**Date**: 2026-04-06
**Status**: Research / Design
**Scope**: Forge `/review` stage — handle comments from ANY review tool uniformly

---

## 1. Comment Taxonomy

Every PR review comment falls into one of these types:

| Type | GitHub API Source | Resolvable? | Examples |
|------|-------------------|-------------|----------|
| **Inline thread** | `pulls/{pr}/comments` (review comments on diff) | Yes (GraphQL `resolveReviewThread`) | Greptile inline, CodeRabbit inline, human line comment, Qodo suggestion |
| **General PR comment** | `issues/{pr}/comments` (issue-level comments) | No (can only react/reply) | Greptile summary, CodeRabbit "Additional Comments", human general feedback |
| **Summary/overview** | `issues/{pr}/comments` (long-form) | No | Greptile confidence summary, CodeRabbit walkthrough, Qodo test summary |
| **Check run annotation** | `check-runs/{id}/annotations` | No (fix code to clear) | GitHub Actions lint errors, test failures, build errors |
| **Outside-diff issue** | `issues/{pr}/comments` (mentions files not in diff) | No | CodeRabbit "related issues outside diff" |
| **Suggestion block** | `pulls/{pr}/comments` with `suggestion` body | Yes | GitHub suggestion format (````suggestion` block), Qodo code fix |
| **Confidence-scored issue** | `issues/{pr}/comments` or inline | Depends | Greptile confidence score, SonarCloud severity rating |
| **AI fix prompt** | `issues/{pr}/comments` or inline | Depends | CodeRabbit "apply fix" instruction, Qodo "generate test" |

### Key insight

All comments ultimately come from two GitHub API endpoints:
1. **Review comments** (`GET /repos/{owner}/{repo}/pulls/{pr}/comments`) — attached to diff lines, have `pull_request_review_id`, resolvable
2. **Issue comments** (`GET /repos/{owner}/{repo}/issues/{pr}/comments`) — general comments, not resolvable (only deletable/reactable)

Check annotations are a third source (`GET /repos/{owner}/{repo}/check-runs/{id}/annotations`).

---

## 2. Comment Handling Decision Matrix

### Priority order: Security > Correctness > Quality > Style

| Comment Category | Action | Reply Template |
|-----------------|--------|----------------|
| **Security vulnerability** (any source) | Fix immediately, commit, reply with SHA, resolve | "Fixed: [description]. Commit: [sha]" |
| **Correctness bug** (any source) | Fix, commit, reply, resolve | "Fixed: [description]. Commit: [sha]" |
| **Failing check annotation** | Fix code so annotation clears on re-run | Commit message documents fix |
| **Valid quality improvement** | Fix if low-effort; defer if large scope | "Fixed in [sha]" or "Deferred to [issue-id]" |
| **Valid style issue** | Fix (usually auto-fixable) | "Fixed in [sha]" |
| **False positive** | Reply explaining why, resolve | "Not applicable: [reasoning]" |
| **Out of scope** | Reply, create tracking issue, resolve | "Out of scope for this PR. Tracked in [issue-id]" |
| **Duplicate** (same issue from 2+ tools) | Fix once, reply to all threads referencing the fix | "Fixed in [sha] (also reported by [other-tool])" |
| **Suggestion block** | Apply if valid (GitHub API or manual), commit | "Applied suggestion. Commit: [sha]" |
| **AI fix prompt** | Evaluate prompt, apply if correct, reply | "Applied recommended fix. Commit: [sha]" |

### Actionability scoring (0-10)

Score each comment to decide if it's worth fixing:

| Dimension | Weight | Criteria |
|-----------|--------|----------|
| Severity | 3x | security=10, bug=8, quality=5, style=2, info=1 |
| Confidence | 2x | Tool confidence score if available, else 7 for humans, 5 for AI |
| Effort | 1x | Inverse: 1-line fix=10, refactor=3, architecture change=1 |
| Scope match | 1x | In this PR's scope=10, tangential=5, unrelated=1 |

**Threshold**: weighted score >= 25 -> fix now. 15-24 -> fix if batching. <15 -> defer/dismiss.

---

## 3. Source Detection & Normalization

### How to detect which tool posted a comment

| Tool | Detection Signal | Where |
|------|-----------------|-------|
| **Greptile** | `user.login` contains `greptile-apps` or `greptile` | Both inline and issue comments |
| **CodeRabbit** | `user.login` is `coderabbitai` | Both inline and issue comments |
| **Qodo** (Codium) | `user.login` contains `qodo` or `codiumai` | Both inline and issue comments |
| **SonarCloud** | `user.login` is `sonarcloud[bot]` or check run name contains `sonarcloud` | Issue comments + check annotations |
| **GitHub Actions** | Check run annotations (not comments) | `check-runs/{id}/annotations` |
| **Dependabot** | `user.login` is `dependabot[bot]` | Issue comments |
| **Human** | `user.type === "User"` and not matching any bot pattern | Both |
| **Codex** | `user.login` contains `codex` or body contains codex signature | Both |

### Unified comment format

```typescript
interface NormalizedComment {
  // Identity
  id: string;                    // GitHub comment ID (for replies)
  threadId?: string;             // GraphQL thread ID (for resolving)
  source: 'greptile' | 'coderabbit' | 'qodo' | 'sonarcloud' | 'github-actions' | 'human' | 'codex' | 'unknown';

  // Location
  type: 'inline' | 'general' | 'summary' | 'annotation' | 'outside-diff' | 'suggestion';
  file?: string;                 // File path (if inline/annotation)
  line?: number;                 // Line number (if inline/annotation)
  side?: 'LEFT' | 'RIGHT';      // Diff side

  // Content
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'security' | 'correctness' | 'quality' | 'style' | 'performance' | 'test' | 'docs';
  message: string;               // Human-readable issue description
  suggestion?: string;           // Code suggestion (if applicable)
  fixPrompt?: string;            // AI fix instruction (if applicable)
  confidence?: number;           // Tool's confidence (0-1) if provided

  // State
  resolved: boolean;
  actionabilityScore: number;    // Computed score (see matrix above)
}
```

### Parsing strategy per tool

**Greptile**: Body contains structured markdown. Confidence score in summary comment. Inline comments have file+line. Use existing `greptile-resolve.sh` patterns.

**CodeRabbit**: Body uses headers like `## Walkthrough`, `## Changes`, `## Sequence Diagram`. Inline comments have actionable suggestions. "Additional Comments" section in summary. Fix prompts embedded in comment body.

**SonarCloud**: Posts quality gate status as issue comment. Inline issues come as check annotations, not PR comments. Parse annotation `message` + `annotation_level` (failure/warning/notice).

**Qodo**: Posts test suggestions as inline comments with code blocks. Summary comment lists generated tests.

**GitHub Actions**: No comments — only check run annotations. Parse via `gh api repos/{owner}/{repo}/check-runs/{id}/annotations`.

**Human**: No structured format. Use the raw body. Detect approval/request-changes via `pulls/{pr}/reviews` endpoint (`state` field).

---

## 4. Efficient Push Strategy for Review Fixes

### The problem

Current: 2-line fix -> 3-4 min local tests -> 3-4 min CI = **6-8 min per fix**
With 8 review comments, that's **48-64 min** of serial fix-push-wait cycles.

### Solution: Batch + Smart Selection

#### Strategy A: Batch all fixes, push once

```
1. Process ALL review comments
2. Fix all issues locally (multiple commits or one commit)
3. Run local validation ONCE
4. Push ONCE
5. CI runs ONCE
Total: N fixes + 1 local run + 1 CI run = ~10 min regardless of comment count
```

**When to use**: Most review cycles. This is the default.

#### Strategy B: `forge push --quick` (lint-only, CI handles tests)

```
1. Fix all issues
2. Run lint only (30s)
3. Push
4. CI runs full suite (3-4 min, but you're not blocked)
Total: N fixes + 30s + push. CI runs async.
```

**When to use**: Review-cycle fixes where you trust CI. The `/review` command already supports this. Good for style/docs fixes.

#### Strategy C: Smart test selection (affected tests only)

```bash
# Bun: filter by changed file's test
bun test --filter "changed-module"

# Jest: only tests related to changed files
jest --changedSince HEAD~1

# Vitest: related tests
vitest related src/changed-file.ts

# nx: affected projects only
nx affected --target=test
```

**Forge integration**: `forge test --affected` already exists. Uses git diff to find changed files, then runs only matching test files.

**When to use**: When you need local test confidence but full suite is slow.

#### Strategy D: Confidence-based local testing

| Fix type | Local test needed? | Rationale |
|----------|-------------------|-----------|
| Style/formatting | No (lint only) | No behavioral change |
| Documentation | No | No code change |
| Variable rename | Run affected test | Low risk but verify |
| Logic fix | Run affected test | Must verify behavior |
| Security fix | Run affected + security tests | High stakes |
| API change | Run full suite | Wide blast radius |

#### Recommendation for Forge

Add to `forge push` a `--review` flag:

```bash
forge push --review    # Batch review fixes:
                       # 1. Lint (fast fail)
                       # 2. Affected tests only (smart selection)
                       # 3. Push
                       # 4. CI runs full suite async
```

This gives **local confidence** (affected tests pass) without **full suite cost** (CI handles that).

---

## 5. Skills Architecture

### Recommendation: Unified skill with pluggable parsers

**One skill** (`/review`) with **per-tool parser modules**, not separate skills per tool.

#### Rationale

- The *workflow* is identical for all tools: fetch -> parse -> prioritize -> fix -> reply -> resolve
- Only the *parsing* differs per tool
- Separate skills would duplicate 80% of the logic
- Agent only needs to invoke one command: `/review <pr-number>`

#### Architecture

```
.claude/commands/review.md          # Orchestrator (existing, enhanced)
.claude/rules/greptile-review-process.md  # Greptile-specific rules (existing)
.claude/scripts/greptile-resolve.sh       # Greptile thread resolution (existing)

# NEW: Universal review infrastructure
lib/review/                         # Parser modules
  types.ts                          # NormalizedComment interface
  detect-source.ts                  # Bot detection logic
  parse-greptile.ts                 # Greptile comment parser
  parse-coderabbit.ts               # CodeRabbit comment parser
  parse-sonarcloud.ts               # SonarCloud parser (annotations)
  parse-qodo.ts                     # Qodo parser
  parse-github-actions.ts           # Check annotation parser
  parse-human.ts                    # Human comment parser
  normalize.ts                      # Unified normalization pipeline
  score.ts                          # Actionability scoring
  index.ts                          # Main entry: fetch all -> normalize -> sort

# Enhanced resolve script (extend existing)
.claude/scripts/review-resolve.sh   # Universal resolve (wraps greptile-resolve.sh pattern)
```

#### Parser plugin contract

```typescript
interface ReviewParser {
  /** Detect if this comment was posted by this tool */
  matches(comment: GitHubComment): boolean;

  /** Parse tool-specific format into normalized comments */
  parse(comment: GitHubComment): NormalizedComment[];

  /** Tool-specific severity mapping */
  mapSeverity(toolSeverity: string): NormalizedComment['severity'];
}
```

Each parser implements this interface. The orchestrator:
1. Fetches all comments (review + issue + annotations)
2. Runs each through parser detection
3. Normalizes to `NormalizedComment[]`
4. Sorts by actionability score
5. Agent processes in priority order

#### Why not separate skills?

| Approach | Pros | Cons |
|----------|------|------|
| **One skill, pluggable parsers** | Single entry point, no duplication, easy to add tools | Parser code needed per tool |
| **Separate skills per tool** | Independent, tool-specific docs | 80% duplicated workflow, agent must know which skill to call, ordering problems |
| **Hybrid (skill per tool + orchestrator)** | Clean separation | Over-engineered for the problem |

**Verdict**: One unified `/review` skill (already exists) with parser modules in `lib/review/`. Adding a new review tool = add one parser file + register in `normalize.ts`.

---

## 6. Implementation Priorities

### Phase 1: Batch push optimization (quick win)

- Add `forge push --review` flag (lint + affected tests + push)
- Modify `/review` command to batch all fixes before pushing
- **Impact**: Reduces 48-64 min review cycles to ~10 min

### Phase 2: Universal comment fetcher

- Build `lib/review/normalize.ts` pipeline
- Implement parsers for Greptile (port existing patterns) + GitHub Actions
- Output sorted `NormalizedComment[]` for agent consumption
- **Impact**: Agent sees one unified list instead of checking 5 different sources

### Phase 3: Additional parsers

- Add CodeRabbit, SonarCloud, Qodo, human parsers
- Add actionability scoring
- **Impact**: Full coverage of review ecosystem

### Phase 4: Smart test selection integration

- Wire `forge test --affected` into review push workflow
- Map changed files -> test files automatically
- **Impact**: Local confidence without full suite cost

---

## 7. Open Questions

1. **Should the universal parser be a CLI command?** (e.g., `forge review-comments <pr>` outputs JSON) — would let any agent consume it, not just Claude.
2. **Thread resolution for non-Greptile tools**: CodeRabbit threads use the same GitHub API. Should `review-resolve.sh` be generalized now or kept Greptile-specific?
3. **CI-only mode**: Should `forge push --review` have a `--ci-only` variant that skips all local checks and fully trusts CI? Risky but fastest.
4. **Comment deduplication**: When Greptile and SonarCloud flag the same line, how to detect and merge? File+line matching? Fuzzy message similarity?
