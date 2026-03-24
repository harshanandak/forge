# Validation & Enforcement

Forge includes built-in validation and TDD enforcement to ensure quality and consistency.

## Table of Contents

- [Git Hooks](#git-hooks)
- [Validation CLI](#validation-cli)
- [Validators by Stage](#validators-by-stage)
- [Override Mechanisms](#override-mechanisms)
- [Configuration](#configuration)

---

## Git Hooks

Forge uses [Lefthook](https://github.com/evilmartians/lefthook) for fast, language-agnostic git hooks.

### Pre-Commit Hook

**Purpose**: Enforce TDD by blocking commits of source code without tests.

**Trigger**: Before every commit

**Checks**:
- Detects staged source files (`.js`, `.ts`, `.py`, `.go`, `.java`, `.rb`, etc.)
- Verifies corresponding test files exist (`.test.js`, `.spec.ts`, etc.)
- Excludes config files, test files, and documentation

**Behavior**:
When source code lacks tests, offers guided recovery:

```
⚠️  Looks like you're committing source code without tests:

  - src/user-service.js

📋 TDD Reminder:
  Write tests BEFORE implementation (RED-GREEN-REFACTOR)

What would you like to do?
  1. Unstage source files (keep tests staged)
  2. Continue anyway (I have a good reason)
  3. Abort commit (let me add tests)

Your choice (1-3):
```

**Override**:
```bash
git commit --no-verify  # Skip in emergencies
```

### Pre-Push Hook

**Purpose**: Ensure all tests pass before pushing to remote.

**Trigger**: Before every push

**Checks**:
- Runs `bun test`
- Verifies all tests pass

**Override**:
```bash
LEFTHOOK=0 git push  # Skip all hooks
```

---

## Validation CLI

The `forge-preflight` CLI checks prerequisites for each workflow stage.

### Usage

```bash
forge-preflight <command>
```

### Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `status` | Check project prerequisites | Setup, onboarding |
| `dev` | Validate before `/dev` | Before implementation |
| `ship` | Validate before `/ship` | Before creating PR |

---

## Validators by Stage

### `forge-preflight status`

**Purpose**: Check basic project setup

**Checks**:
- ✓ Git repository initialized
- ✓ `package.json` exists
- ✓ Test framework configured (`bun test` script)
- ✓ Node.js installed

**Example**:
```bash
$ forge-preflight status

Checking project prerequisites...

Validation Results:

  ✓ Git repository
  ✓ package.json exists
  ✓ Test framework configured
  ✓ Node.js installed

✅ All checks passed!
```

---

### `forge-preflight dev`

**Purpose**: Validate before starting implementation (`/dev`)

**Checks**:
- ✓ On feature branch (`feat/*`, `fix/*`, `docs/*`)
- ✓ Plan file exists (`docs/plans/*.md`)
- ✓ Research file exists (`docs/research/*.md`)
- ✓ Test directory exists

**Example**:
```bash
$ forge-preflight dev

Validating prerequisites for /dev stage...

Validation Results:

  ✓ On feature branch
  ✓ Plan file exists
  ✓ Research file exists
  ✓ Test directory exists

✅ All checks passed!
```

**Failed Example**:
```bash
$ forge-preflight dev

Validating prerequisites for /dev stage...

Validation Results:

  ✗ On feature branch
    Not on a feature branch. Create one: git checkout -b feat/your-feature
  ✓ Plan file exists
  ✗ Research file exists
    No research file found in docs/research/. Run: /research

❌ Some checks failed. Please fix the issues above.
```

---

### `forge-preflight ship`

**Purpose**: Validate before creating PR (`/ship`)

**Checks**:
- ✓ Tests exist (`.test.js`, `.spec.ts` files)
- ✓ Tests pass (`bun test` succeeds)
- ✓ Documentation updated (`README.md` or `docs/`)
- ✓ No uncommitted changes

**Example**:
```bash
$ forge-preflight ship

Validating prerequisites for /ship stage...

Validation Results:

  ✓ Tests exist
  ✓ Tests pass
  ✓ Documentation updated
  ✓ No uncommitted changes

✅ All checks passed!
```

---

## Override Mechanisms

### Git Hooks

**Emergency Override** (use sparingly):

```bash
# Skip pre-commit hook
git commit --no-verify -m "Emergency hotfix"

# Skip pre-push hook
LEFTHOOK=0 git push
```

**When to use**:
- Emergency hotfixes
- Work-in-progress commits (before pushing)
- Non-code commits (docs, config)

**When NOT to use**:
- Regular development
- Public repositories
- Production deployments

### Validation CLI

The CLI provides guidance but doesn't block actions. You can proceed manually if checks fail.

---

## Configuration

### Lefthook Configuration

Edit `lefthook.yml` to customize hooks:

```yaml
pre-commit:
  commands:
    tdd-check:
      run: node .forge/hooks/check-tdd.js
      stage_fixed: false
      tags: tdd
      glob: "*.{js,ts,jsx,tsx,py,go,java,rb}"

pre-push:
  commands:
    tests:
      run: bun test
      tags: tests
```

**Options**:
- `run`: Command to execute
- `stage_fixed`: Auto-stage modified files (false = safer)
- `tags`: Categorize hooks
- `glob`: File patterns to trigger hook

### Custom Test Patterns

Edit `.forge/hooks/check-tdd.js` to add custom test patterns:

```javascript
// Around line 72
const testPatterns = [
  `${basename}.test${ext}`,
  `${basename}.spec${ext}`,
  `test/${basename}.test${ext}`,
  `tests/${basename}.test${ext}`,
  `__tests__/${basename}.test${ext}`,
  // Add custom patterns here
  `${dir}/__tests__/${basename}${ext}`,
  `spec/${basename}_spec${ext}`,  // RSpec style
];
```

### Validation CLI Customization

Edit `bin/forge-preflight.js` to add custom validators:

```javascript
function validateCustomStage() {
  console.log('Validating custom stage...\n');

  check('Custom check', () => {
    // Your validation logic
    return true;
  }, 'Custom error message');

  return printResults();
}
```

---

## Installation

Hooks are automatically installed when you run:

```bash
# Install lefthook (one-time)
bun add -d lefthook

# Set up Forge
bunx forge setup
```

The hooks will be automatically installed in your project's `.git/hooks/` directory.

**Manual installation** (if needed):

```bash
# If you prefer global installation
bun install -g lefthook

# Install hooks
lefthook install
```

---

## Troubleshooting

### Hooks not running

```bash
# Check lefthook installation
lefthook version

# Reinstall hooks
lefthook install

# Check git hooks directory
ls -la .git/hooks/
```

### False positives

If the hook incorrectly flags a file:

1. **Short-term**: Use `--no-verify` to skip
2. **Long-term**: Update exclusion patterns in `.forge/hooks/check-tdd.js`

### Tests failing on push

```bash
# Run tests locally
bun test

# Fix failures, then
git push
```

---

## Best Practices

1. **Write tests first**: Let the hooks guide you to TDD
2. **Don't abuse overrides**: Only use `--no-verify` in emergencies
3. **Keep tests fast**: Pre-push hooks run on every push
4. **Document exceptions**: If you override, explain why in commit message
5. **Update validators**: Customize for your project's needs

---

## See Also

- [Workflow Guide](../AGENTS.md) - Complete 7-stage workflow
- [TDD Guide](../CLAUDE.md) - TDD principles and practices
- [Lefthook Docs](https://github.com/evilmartians/lefthook) - Full hook configuration
