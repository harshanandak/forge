# Quickstart Guide

Get started with Forge in 5 minutes. Ship your first feature with tests, security, and documentation.

---

## Prerequisites

Before you begin, ensure you have:

- **Node.js** (v16 or higher) - [Download here](https://nodejs.org)
- **Git** installed and configured
- **GitHub account** with repository access
- **GitHub CLI** (recommended):
  ```bash
  # macOS
  brew install gh && gh auth login

  # Windows
  winget install GitHub.cli && gh auth login

  # Linux
  sudo apt install gh && gh auth login
  ```

**Time required**: 5 minutes for first feature

---

## Installation

### Step 1: Install Forge

```bash
npm install forge-workflow
```

This installs the package and creates `AGENTS.md` in your project.

### Step 2: Configure for Your AI Agent

```bash
npx forge setup
```

**Interactive setup** will ask:
```
? Which AI agents are you using?
  ◉ Claude Code
  ◯ Cursor
  ◯ Windsurf
  ◯ GitHub Copilot
  (use space to select, enter to confirm)
```

**Or specify directly**:
```bash
npx forge setup --agents claude,cursor,windsurf
```

**What this creates**:
- `AGENTS.md` - Universal instructions
- Agent-specific files (`.claude/commands/`, `.cursorrules`, etc.)
- `docs/WORKFLOW.md` - Complete workflow guide
- `docs/TOOLCHAIN.md` - Toolchain reference

---

## Your First Feature (5 Minutes)

Let's add a health check endpoint to demonstrate the full workflow.

### Stage 1: Check Status

```bash
$ npx forge /status
```

**Output:**
```
✓ Current branch: main
✓ Working directory: clean
✓ No active issues
✓ No active work in progress

Ready to start!
```

**What it checks**:
- Git branch and status
- Active issues (if Beads installed)
- Current work state

---

### Stage 2: Research

```bash
$ npx forge /research health-check-endpoint
```

**What happens**:
1. AI searches web for health check best practices
2. Analyzes your codebase for existing patterns
3. OWASP Top 10 security analysis
4. Documents findings in `docs/research/health-check-endpoint.md`

**Research doc includes**:
- Best practices (REST conventions, status codes)
- Security considerations (information disclosure risks)
- Existing patterns in your codebase
- TDD test scenarios identified upfront

**Time**: ~2 minutes

---

### Stage 3: Plan

```bash
$ npx forge /plan health-check-endpoint
```

**What happens**:
1. Creates feature branch: `feat/health-check-endpoint`
2. Creates tracking issue (if Beads installed)
3. Creates implementation plan

**Output:**
```
✓ Created branch: feat/health-check-endpoint
✓ Created issue: PROJ-42
✓ Plan ready in: docs/planning/health-check-endpoint.md

Next: /dev to start TDD implementation
```

**Time**: ~30 seconds

---

### Stage 4: Development (TDD)

```bash
$ npx forge /dev
```

**The AI guides you through RED-GREEN-REFACTOR**:

**RED** - Write failing test first:
```javascript
// tests/health.test.js
describe('GET /health', () => {
  it('returns 200 OK with status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

Run test → ❌ Fails (endpoint doesn't exist)

**GREEN** - Minimal code to pass:
```javascript
// routes/health.js
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
```

Run test → ✅ Passes

**REFACTOR** - Clean up if needed, then commit:
```bash
git add .
git commit -m "test: add health check endpoint test

- Returns 200 OK
- JSON response with status field

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Repeat for edge cases** (if any)

**Time**: ~8 minutes

---

### Stage 5: Check

```bash
$ npx forge /check
```

**What runs**:
```
Running type check... ✓
Running linter...     ✓
Running unit tests... ✓ (1 test passed)
Running security scan... ✓ (no vulnerabilities)
```

**If anything fails**, fix it before proceeding.

**Time**: ~1 minute

---

### Stage 6: Ship

```bash
$ npx forge /ship
```

**What happens**:
1. Pushes branch to GitHub
2. Creates pull request with documentation

**PR includes**:
```markdown
## Summary
- Added GET /health endpoint
- Returns 200 OK with status: ok
- Minimal information disclosure

## Research
See: docs/research/health-check-endpoint.md

## Test Coverage
- 1 unit test (health endpoint returns 200 OK)

## Security
- ✓ OWASP A01: No sensitive data exposed
- ✓ OWASP A03: No injection vectors
```

**Output:**
```
✓ Pushed branch: feat/health-check-endpoint
✓ Created PR: #42
✓ URL: https://github.com/you/project/pull/42

Next: /review to address feedback
```

**Time**: ~1 minute

---

### Stage 7: Review (if needed)

```bash
$ npx forge /review 42
```

**Addresses**:
- GitHub Actions failures
- Code review comments
- Security scan issues
- CI/CD feedback

Fix issues, commit, push - PR updates automatically.

---

### Stage 8: Merge

```bash
$ npx forge /merge 42
```

**Before merging**, updates:
- `docs/planning/PROGRESS.md` (if exists)
- API documentation (if needed)
- README (if user-facing)

Then merges the PR with squash commit.

**Output:**
```
✓ Updated documentation
✓ Merged PR #42
✓ Deleted branch: feat/health-check-endpoint
✓ Issue PROJ-42: closed

Back on main branch. Ready for next feature!
```

**Time**: ~1 minute

---

### Stage 9: Verify

```bash
$ npx forge /verify
```

**Final checks**:
- Documentation cross-references valid
- Examples work
- No broken links
- Everything up to date

---

## What You Just Did

In **5 minutes**, you:

✅ Researched best practices with AI
✅ Created plan with security analysis
✅ Wrote tests BEFORE code (TDD)
✅ Validated with type checking, linting, security scan
✅ Created PR with full documentation
✅ Merged with confidence

**All with tests, security, and docs built-in.**

---

## What's Next?

### Try These Common Workflows

**Simple feature** (like you just did):
```bash
/research → /plan → /dev → /check → /ship
```

**Bug fix with security**:
```bash
/research sql-injection-fix
/plan sql-injection-fix
/dev  # Fix + tests
/check  # Security scan critical
/ship
```

**Architecture change** (uses OpenSpec):
```bash
/research user-authentication
/plan user-authentication  # Creates OpenSpec proposal
# → Create PR for proposal approval first
/dev
/check
/ship
/review
/merge
/verify
```

---

### Optional: Install Toolchain

**Beads** - Issue tracking that persists across sessions:
```bash
npm install -g @beads/bd
bd init
bd ready  # Find work to do
```

**OpenSpec** - Spec-driven development for architecture:
```bash
npm install -g @fission-ai/openspec
openspec init
```

---

### Learn More

📖 **Full Workflow Guide**
→ [docs/WORKFLOW.md](docs/WORKFLOW.md)

🛠️ **Toolchain Reference**
→ [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md)

🎯 **Real-World Examples**
→ [docs/EXAMPLES.md](docs/EXAMPLES.md)

🔧 **Agent Setup**
→ [docs/SETUP.md](docs/SETUP.md)

💬 **Questions?**
→ [GitHub Discussions](https://github.com/harshanandak/forge/discussions)

---

## Quick Reference

```bash
/status       # Check current state
/research X   # Research feature X
/plan X       # Create plan for X
/dev          # TDD development
/check        # Validate everything
/ship         # Create PR
/review N     # Address PR #N feedback
/merge N      # Merge PR #N
/verify       # Final docs check
```

---

## Tips for Success

**1. Always start with /status**
Know where you are before starting new work.

**2. Don't skip research**
2 minutes of research saves hours of refactoring.

**3. Write tests first (RED-GREEN-REFACTOR)**
Tests written after code are half as effective.

**4. Use Beads for multi-session work**
Don't rely on memory - track issues in git.

**5. OpenSpec for architecture changes**
Get approval on design before implementing.

---

**Ready to ship your next feature?**

```bash
/status
```

Then start with `/research <your-feature-name>` 🚀
