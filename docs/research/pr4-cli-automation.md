# Research: PR4 - CLI Command Automation

**Date**: 2026-02-14
**Feature**: Automate Forge workflow commands with executable CLI dispatcher

---

## Objective

Transform Forge from **documentation-driven workflow** to **CLI-automated workflow**.

**Deliverables**:
1. Executable command dispatcher (`bin/forge-cmd.js`)
2. Intelligent stage detection (auto-detect workflow stage 1-9)
3. Automated command handlers (`/research`, `/plan`, `/ship`, `/review`)
4. PR body auto-generation (from research + plan + tests)
5. Review aggregation (Greptile + SonarCloud + GitHub Actions)

---

## Codebase Analysis

### Current Architecture

**CLI Entry Points**:
- `bin/forge.js` (3,800+ lines) - Setup with agent configuration
- `bin/forge-validate.js` (304 lines) - Validation with switch dispatch

**Commands**: `.claude/commands/` - 11 markdown files defining workflow stages

**Critical Gap**: Commands are documentation only, not executable code

### Existing Patterns to Follow

**State Management** (lib/setup.js):
- saveSetupState() - Persist progress
- loadSetupState() - Resume from last state
- isSetupComplete() - Check completion

**Validation Pattern** (bin/forge-validate.js):
- Modular dispatch with switch statement
- Separate handler functions per command
- Export for testing

**Test Infrastructure**:
- 576 tests across 36 files
- E2E framework with fixtures
- Snapshot testing
- 80% coverage thresholds

---

## Security Analysis (OWASP Top 10)

### A03: Injection (CRITICAL for CLI)

**Command Injection Risk**:
- User input in `/research <name>`, `/plan <slug>`
- **Mitigation**: Never use exec() with user input

**Safe Pattern**:
```javascript
// UNSAFE
exec(`gh pr create --title "${userInput}"`);

// SAFE
execFile('gh', ['pr', 'create', '--title', userInput]);
```

**Input Validation**:
- Feature slugs: `/^[a-z0-9-]+$/` only
- No spaces, dots, slashes
- Max length: 50 characters

**Path Traversal Prevention**:
```javascript
const slug = path.basename(userInput); // Strip paths
if (!/^[a-z0-9-]+$/.test(slug)) {
  throw new Error('Invalid feature slug');
}
```

### A01: Broken Access Control

**File Permission Checks**:
```javascript
fs.accessSync(dir, fs.constants.W_OK); // Check before write
```

**Git Repository Validation**:
```javascript
// Verify correct repo before operations
const config = fs.readFileSync('.git/config', 'utf-8');
if (!config.includes('expected-repo')) {
  throw new Error('Wrong repository');
}
```

### A04: Insecure Design

**Stage Prerequisites**:
- Don't run `/ship` before `/check` passes
- Validate workflow order
- Provide clear error messages

**Idempotency**:
- Check existing state before creating resources
- Don't duplicate PRs, branches, Beads issues
- Safe to re-run commands

### A05: Security Misconfiguration

**Secret Management**:
- Read from `.env.local` (already implemented)
- Never log full API keys (show first 6 chars only)
- Redact secrets in error messages

### Security Checklist

- [ ] All user input validated with `/^[a-z0-9-]+$/`
- [ ] No exec() with user input
- [ ] Path traversal prevented
- [ ] File permissions checked
- [ ] Git repo validated
- [ ] Stage prerequisites validated
- [ ] Idempotency implemented
- [ ] API keys never logged
- [ ] API responses validated
- [ ] Atomic file writes
- [ ] Dangerous operations require confirmation

---

## Key Decisions

### Decision 1: Plain Node.js (No CLI Framework)

**What**: Use plain Node.js without Commander.js/yargs/oclif

**Why**:
- Forge has established patterns (bin/forge-validate.js)
- Custom logic needed
- No framework overhead
- Testing infrastructure in place

**Alternatives Rejected**:
- Commander.js (unnecessary for 9 commands)
- Yargs (too complex)
- oclif (heavyweight)

### Decision 2: Command Dispatcher Architecture

**Pattern**:
```
bin/forge-cmd.js (CLI entrypoint)
  ↓
lib/commands/
  ├── status.js       → Stage detection
  ├── research.js     → Parallel-AI automation
  ├── plan.js         → Branch + plan + OpenSpec
  ├── ship.js         → PR body generation
  └── review.js       → Review aggregation
```

**Why**: Separation of concerns, testability

### Decision 3: Stage Detection Algorithm

**Multi-factor with confidence scoring**:

Factors:
1. Branch state (exists, commits, matches PR)
2. File existence (research doc, plan, tests)
3. PR state (open, reviews, approval)
4. Check results (CI/CD status)
5. Beads issue state

Confidence:
- High (90-100%): All indicators consistent
- Medium (70-89%): Most agree
- Low (<70%): Conflicting, suggest manual override

### Decision 4: Review Aggregation Format

**Output**:
```
✓ Review Aggregation: 24 issues

Critical (3):
  1. [Greptile] SQL injection (src/api/users.js:42)
  2. [SonarCloud] Security hotspot (src/auth/login.js:78)
  3. [GitHub Actions] Build failed

High (8):
  4. [Greptile] Missing error handling (...)
  ...
```

**Why**: Consolidated, prioritized feedback

---

## TDD Test Scenarios

### Test 1: Stage Detection

```javascript
test('detect stage 1 when no branch, no research', () => {
  const stage = detectStage(freshProject);
  assert.strictEqual(stage.stage, 1);
  assert.strictEqual(stage.confidence, 'high');
});
```

### Test 2: Research Automation

```javascript
test('create research doc from parallel-ai', async () => {
  mockParallelAI({ results: [{ title: 'Best practices' }] });

  await researchCommand(fixture, 'stripe-billing');

  const doc = readFile(fixture, 'docs/research/stripe-billing.md');
  assert.ok(doc.includes('# Research: Stripe Billing'));
});
```

### Test 3: PR Body Generation

```javascript
test('generate PR body from all sources', async () => {
  createFile(fixture, 'docs/research/feature.md', RESEARCH);
  createFile(fixture, '.claude/plans/feature.md', PLAN);

  const prBody = await generatePRBody(fixture, 'feature');

  assert.ok(prBody.includes('## Summary'));
  assert.ok(prBody.includes('## Key Decisions'));
});
```

### Test 4: Review Aggregation

```javascript
test('aggregate all review sources', async () => {
  mockGitHubAPI({ checks: [{ name: 'Tests', status: 'failed' }] });
  mockGreptileAPI({ comments: [{ severity: 'critical' }] });

  const review = await aggregateReview(123);

  assert.strictEqual(review.critical.length, 1);
});
```

### Test 5: E2E Workflow

```javascript
test('complete research workflow end-to-end', async () => {
  execSync('node bin/forge-cmd.js status', { cwd: fixture });
  execSync('node bin/forge-cmd.js research test-feature', { cwd: fixture });
  execSync('node bin/forge-cmd.js plan test-feature', { cwd: fixture });

  const branch = execSync('git branch --show-current', { cwd: fixture });
  assert.ok(branch.includes('feat/test-feature'));
});
```

---

## Scope Assessment

**Complexity**: High
- Multiple handlers with complex logic
- API integrations (GitHub, Greptile, SonarCloud)
- Intelligent stage detection
- PR body generation from multiple sources

**Type**: Strategic (architecture change, requires OpenSpec)

**Timeline**: 3-4 days
- Day 1: Dispatcher + /status enhancement
- Day 2: /research + /plan automation
- Day 3: /ship + /review automation
- Day 4: Testing + documentation

**Dependencies**:
- ✅ PR3 (Testing Infrastructure) - COMPLETE
- Beads CLI (`bd`)
- GitHub CLI (`gh`)
- Parallel AI API key

**Risks**:
1. API rate limits → Caching, retry logic
2. Complex stage detection → Confidence scoring
3. Integration testing → Fixtures, mocking

---

## Sources

**Codebase**:
- bin/forge.js, bin/forge-validate.js
- .claude/commands/*.md
- lib/setup.js (state management)
- test/e2e/ (E2E patterns)

**Web Research** (Parallel AI):
- Command Pattern in Node (Medium)
- Node.js Best Practices
- Multi-Agent Systems
- Workflow orchestration patterns

**Security**:
- OWASP Top 10 2021
- CWE-78 (Command Injection)
- CWE-22 (Path Traversal)

---

## Next: /plan pr4-cli-automation

Create OpenSpec proposal with:
1. Command dispatcher architecture
2. Stage detection algorithm
3. Security mitigations
4. Test strategy
