# Forge

[![npm version](https://img.shields.io/npm/v/forge-workflow.svg)](https://www.npmjs.com/package/forge-workflow)
[![npm downloads](https://img.shields.io/npm/dw/forge-workflow.svg)](https://www.npmjs.com/package/forge-workflow)
[![license](https://img.shields.io/npm/l/forge-workflow.svg)](https://github.com/harshanandak/forge/blob/master/LICENSE)
[![Tests](https://github.com/harshanandak/forge/actions/workflows/test.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/test.yml)
[![ESLint](https://github.com/harshanandak/forge/actions/workflows/eslint.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/eslint.yml)
[![Greptile Quality Gate](https://github.com/harshanandak/forge/actions/workflows/greptile-quality-gate.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/greptile-quality-gate.yml)
[![Package Size](https://github.com/harshanandak/forge/actions/workflows/size-check.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/size-check.yml)
[![CodeQL](https://github.com/harshanandak/forge/actions/workflows/codeql.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/codeql.yml)
[![Security Policy](https://img.shields.io/badge/security-policy-blue.svg)](https://github.com/harshanandak/forge/blob/master/SECURITY.md)

Ship features with confidence using a 9-stage TDD-first workflow for AI coding agents.

```
/status → /research → /plan → /dev → /check → /ship → /review → /merge → /verify
```

✅ **TDD-First**: Write tests before code
✅ **Research-First**: Understand before building
✅ **Multi-Agent**: Universal AGENTS.md works with 8 agents

---

## Quick Example

**Adding a login button with Forge:**

```bash
/research login-button    # AI researches best practices + security
/plan login-button        # Creates plan, branch, tracking issue
/dev                      # TDD: RED → GREEN → REFACTOR cycles
/check                    # Type check + lint + tests + security scan
/ship                     # Create PR with full documentation
```

**Result**: Feature shipped with tests, security validated, fully documented.

**Without Forge** (chaotic):
- Code first, tests later (or never)
- No research or planning
- Security issues found in production
- Documentation forgotten

**With Forge** (systematic):
- Tests written BEFORE code (TDD)
- Research-backed decisions
- OWASP Top 10 analysis built-in
- Documentation at every stage

→ [See complete walkthrough in QUICKSTART.md](QUICKSTART.md)

---

## Installation

```bash
# Step 1: Install the package
bun install forge-workflow

# Step 2: Setup for your AI agent
bunx forge setup
```

**That's it!** Forge will:
- Create AGENTS.md (universal instructions)
- Setup agent-specific files (Claude, Cursor, etc.)
- Create docs/ folder with guides

**Prerequisites**: Node.js, Git, GitHub account
**Optional tools**: Beads (issue tracking), OpenSpec (architecture proposals)

→ [Detailed setup guide for all agents](docs/SETUP.md)

---

## The 9 Stages

| Stage | Command | Purpose |
|-------|---------|---------|
| **1. Status** | `/status` | Check current context, active work |
| **2. Research** | `/research` | Deep research with AI, document findings |
| **3. Plan** | `/plan` | Create plan + branch + tracking |
| **4. Dev** | `/dev` | TDD development (RED-GREEN-REFACTOR) |
| **5. Check** | `/check` | Validate: types, lint, tests, security |
| **6. Ship** | `/ship` | Create PR with documentation |
| **7. Review** | `/review` | Address ALL PR feedback (Greptile, reviewers, CI/CD) |
| **8. Merge** | `/merge` | Update docs, merge, cleanup |
| **9. Verify** | `/verify` | Final documentation check |

**Full workflow guide**: [docs/WORKFLOW.md](docs/WORKFLOW.md)

---

## Supported AI Agents

Works with **8 AI coding agents** via universal AGENTS.md:

### Tier 1 (Primary Support)

| Agent | Features | Setup Time |
|-------|----------|------------|
| **Claude Code** | Custom slash commands, .claude/ directory | 30 seconds |
| **GitHub Copilot** | Enterprise support, .github/copilot-instructions.md | 30 seconds |
| **Kilo Code** | Auto failure recovery, .kilo.md | 30 seconds |
| **Cursor** | Native modes (Plan/Ask/Debug), .cursor/rules/ | 30 seconds |
| **Aider** | Git-integrated, terminal-native, .aider.conf.yml | 30 seconds |

### Tier 2 (Optional Support)

| Agent | Features | Setup Time |
|-------|----------|------------|
| **OpenCode** | Flexible, opencode.json | 30 seconds |
| **Goose** | Model flexibility, open-source | 30 seconds |
| **Antigravity** | Google-backed, early preview | 30 seconds |

**Quick setup** (auto-detects agents):
```bash
bunx forge setup
```

**Setup for specific agent**:
```bash
bunx forge setup --agent=copilot     # GitHub Copilot
bunx forge setup --agent=cursor      # Cursor IDE
bunx forge setup --agent=kilo        # Kilo Code
bunx forge setup --agent=aider       # Aider
```

**Setup for all Tier 1 agents**:
```bash
bunx forge setup --all
```

→ [Agent-specific setup instructions](docs/SETUP.md)

---

## What Makes Forge Different

### 1. TDD-First Development
Tests are written **BEFORE** code, every single time:
- **RED**: Write a failing test
- **GREEN**: Write minimal code to pass
- **REFACTOR**: Clean up and commit
- **REPEAT**: Next feature

No feature ships without tests. Period.

### 2. Research-First Planning
AI researches best practices before you write a line of code:
- Web search for latest patterns
- OWASP Top 10 security analysis
- Codebase pattern analysis
- Decisions documented with evidence

Saves hours of debugging and refactoring later.

### 3. Universal Compatibility
One workflow, works with ALL major AI agents:
- Single `AGENTS.md` file (universal standard)
- Agent-specific enhancements (slash commands, skills)
- Git-backed persistence (Beads)
- No vendor lock-in

Switch agents anytime without changing your workflow.

### 4. Built-in TDD Enforcement (v1.5.0)
Git hooks automatically enforce TDD practices:
- **Pre-commit**: Blocks source commits without tests
- **Pre-push**: Runs full test suite before push
- **Interactive**: Guided recovery when violations occur
- **CI/CD aware**: Auto-aborts in non-interactive environments

```bash
# Validation CLI
forge-validate status    # Check project prerequisites
forge-validate dev       # Validate before /dev stage
forge-validate ship      # Validate before /ship stage
```

### 5. Plugin Architecture (v1.5.0)
11 agent plugins with specialized capabilities:
- Each agent defined by JSON configuration
- Community contributions welcome
- Backwards compatible

→ [Validation docs](docs/VALIDATION.md) | [Plugin docs](lib/agents/README.md)

### 6. Enhanced Onboarding (v1.6.0) 🆕
Smart setup that adapts to your project:

**Intelligent File Merging**
- Preserves your existing AGENTS.md content
- Adds Forge workflow without overwriting
- Three options: smart merge, keep, or replace
```bash
bunx forge setup --merge=smart    # Intelligent merge
```

**Auto-Detection**
- Detects framework (Next.js, React, Vue, Express)
- Detects language (TypeScript, JavaScript)
- Analyzes git stats and CI/CD setup
- Infers project stage (new, active, stable)
- Saves to `.forge/context.json`

**Workflow Profiles**
- Adapts workflow based on work type:
  - `feature`: Full 9-stage workflow (auto-escalates to critical for auth/payment)
  - `fix`: Streamlined 5-stage workflow (auto-escalates to hotfix for production)
  - `refactor`: Behavior-preserving 5-stage workflow
  - `chore`: Minimal 3-stage workflow (docs/deps/config)
```bash
bunx forge setup --type=critical    # Set workflow manually
```

**Context Interview** (optional)
```bash
bunx forge setup --interview    # Gather project context
```

→ [Enhanced onboarding guide](docs/ENHANCED_ONBOARDING.md)

### 7. Automated Quality Gates 🆕
Multi-layer quality enforcement before merge:

**Greptile AI Code Review**
- AI-powered review on every PR
- Catches bugs, security issues, performance problems
- Detailed inline feedback with fix suggestions
- Automatic re-review after changes
```bash
# Branch protection requires Greptile review to pass
# Typically completes in 1-2 minutes
```

**GitHub Actions Workflows**
- Greptile Quality Gate: Enforces minimum score (≥4/5)
- ESLint checks: Code quality validation
- Test suite: All tests must pass

**Git Hooks (Lefthook)**
- Pre-commit: TDD enforcement (tests required)
- Pre-push: Full test suite + lint checks
- Branch protection: Blocks direct push to main/master

→ [Greptile setup guide](docs/GREPTILE_SETUP.md)

---

## The Toolchain

Forge integrates with powerful tools:

```
┌──────────────────────────────────────────────┐
│              FORGE TOOLCHAIN                 │
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  BEADS   │  │ OPENSPEC │  │  GITHUB  │   │
│  │  Issue   │  │ Proposal │  │    PR    │   │
│  │ Tracking │  │  System  │  │ Workflow │   │
│  └──────────┘  └──────────┘  └──────────┘   │
│       │              │              │        │
│       └──────────────┴──────────────┘        │
│                      │                       │
│                ┌─────▼─────┐                 │
│                │   FORGE   │                 │
│                │ 9-Stage   │                 │
│                │ Workflow  │                 │
│                └───────────┘                 │
│                                              │
└──────────────────────────────────────────────┘
```

**All tools are optional** - Forge works standalone.

**Beads** (optional): Git-backed issue tracking that survives context clearing
```bash
bun add -g @beads/bd && bd init
```

**OpenSpec** (optional): Spec-driven development for architecture changes
```bash
bun add -g @fission-ai/openspec && openspec init
```

**GitHub CLI** (recommended): Required for PR workflow
```bash
gh auth login
```

→ [Complete toolchain guide](docs/TOOLCHAIN.md)

---

## Real-World Examples

### Example 1: Simple Feature (20 minutes)
**Task**: Add a health check endpoint

```bash
/research health-check-endpoint  # 2 min: Research patterns
/plan health-check-endpoint      # 1 min: Create plan + branch
/dev                             # 8 min: TDD implementation
/check                           # 2 min: All validations pass
/ship                            # 2 min: PR created
# → Greptile AI review completes (~2 min)
/review                          # 3 min: Address Greptile feedback
/merge                           # 2 min: Merge + cleanup
```

### Example 2: Bug Fix with Security (30 minutes)
**Task**: Fix SQL injection vulnerability

```bash
/research sql-injection-fix      # 5 min: OWASP research
/plan sql-injection-fix          # 2 min: Plan + branch
/dev                             # 8 min: Fix + tests
/check                           # 3 min: Security scan
/ship                            # 2 min: PR with security notes
# → Greptile validates security fix (~2 min)
/review                          # 5 min: Address security feedback
/merge                           # 3 min: Merge + verify
```

### Example 3: Architecture Change (2-3 days)
**Task**: Add authentication system

```bash
/research user-authentication    # 30 min: Deep research
/plan user-authentication        # 60 min: OpenSpec proposal
# → Create PR for proposal approval first
/dev                             # 1-2 days: TDD implementation
/check                           # 30 min: Full validation
/ship                            # 15 min: PR with docs
/review                          # Varies: Address feedback
/merge                           # 15 min: Merge + cleanup
/verify                          # 15 min: Final check
```

→ [More examples in docs/EXAMPLES.md](docs/EXAMPLES.md)

---

## Core Principles

**TDD-First**: Tests before code, always
**Research-First**: Understand before building
**Security Built-In**: OWASP Top 10 for every feature
**Documentation Progressive**: Update at each stage
**Multi-Session**: Work persists across sessions

→ [Read the philosophy in docs/WORKFLOW.md](docs/WORKFLOW.md)

---

## Next Steps

📚 **New to Forge?**
→ [QUICKSTART.md](QUICKSTART.md) - Your first feature in 5 minutes

📖 **Learn the workflow**
→ [docs/WORKFLOW.md](docs/WORKFLOW.md) - Complete guide with examples

🛠️ **Setup the toolchain**
→ [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) - Beads, OpenSpec, GitHub CLI

🎯 **See real examples**
→ [docs/EXAMPLES.md](docs/EXAMPLES.md) - Real-world use cases

💬 **Have questions?**
→ [GitHub Discussions](https://github.com/harshanandak/forge/discussions)

🐛 **Found a bug?**
→ [GitHub Issues](https://github.com/harshanandak/forge/issues)

---

## Quick Reference

```bash
# Forge commands
/status                    # Check current context
/research <feature>        # Research + document
/plan <feature>            # Create plan + branch
/dev                       # TDD development
/check                     # Validate everything
/ship                      # Create PR
/review <pr>               # Address feedback
/merge <pr>                # Merge + cleanup
/verify                    # Final docs check

# Beads commands (optional)
bd init                    # Initialize tracking
bd ready                   # Find ready work
bd create "title"          # Create issue
bd update <id> --status X  # Update status
bd sync                    # Sync with git

# OpenSpec commands (optional)
/opsx:new                  # Start change
/opsx:ff                   # Generate all docs
/opsx:apply                # Implement tasks
/opsx:archive              # Complete change
```

---

## License

MIT © Harsha Nandak

---

**Ready to start?**

```bash
bun install forge-workflow
bunx forge setup
/status
```

Then open [QUICKSTART.md](QUICKSTART.md) and ship your first feature! 🚀
