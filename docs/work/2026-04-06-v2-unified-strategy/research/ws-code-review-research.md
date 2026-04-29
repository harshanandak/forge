# Code Review Tools & Agents — Industry Research

**Date**: 2026-04-06
**Purpose**: Understand industry best practices for Forge's `/review` system
**Sources**: Official documentation for each tool (fetched and verified)

---

## 1. CodeRabbit

**Website**: https://coderabbit.ai
**Integration model**: GitHub App (webhook-based), also available as IDE extension and CLI tool
**Docs**: https://docs.coderabbit.ai

### Supported Tools (50 total)

CodeRabbit integrates **50 static analysis tools**, linters, and security scanners. All are enabled by default and auto-detected based on project files present in the repository.

#### By Language/Category

| Category | Tools |
|----------|-------|
| **JavaScript/TypeScript** | ESLint, Biome, Oxlint (OXC) |
| **Python** | Ruff, Pylint, Mypy |
| **Go** | golangci-lint |
| **Rust** | Clippy |
| **Ruby** | RuboCop |
| **PHP** | PHPCS, PHPMD, PHPStan |
| **Kotlin** | Detekt, Ktlint |
| **Java** | Checkstyle, PMD (inferred from pattern) |
| **Swift** | SwiftLint |
| **C/C++** | Clang (static analysis), Cppcheck |
| **Terraform** | TFLint, Checkov |
| **Docker** | Hadolint |
| **Shell** | ShellCheck |
| **HTML** | HTMLHint |
| **CSS/SCSS** | Stylelint |
| **Markdown** | MarkdownLint |
| **YAML** | YAMLlint |
| **Rego (OPA)** | Regal |
| **SQL** | SQLFluff (inferred) |
| **PowerShell** | PSScriptAnalyzer |
| **Batch files** | Blinter |
| **GitHub Actions** | Actionlint |
| **AST patterns** | ast-grep (with essentials package) |
| **Security scanning** | Semgrep, Gitleaks/Betterleaks, Trivy, OSV Scanner, Checkov |
| **Dependency** | OSV Scanner (vulnerability scanning) |

#### Auto-Detection Mechanism

- All 50 tools are **enabled by default** (`enabled: true`)
- CodeRabbit auto-detects which tools are relevant by checking for project files (e.g., `package.json` → ESLint/Biome, `Cargo.toml` → Clippy, `go.mod` → golangci-lint)
- Tools respect existing config files (`.eslintrc.js`, `pyproject.toml`, `.golangci.yml`, etc.)
- Users can override via `.coderabbit.yaml` in the repo root
- Two review profiles control strictness: **Chill** (critical issues only) vs **Assertive** (comprehensive including style)

### Comment Format

1. **PR Summary** — Posted as a single PR comment with:
   - Walkthrough of all changes (file-by-file)
   - Sequence diagrams where applicable
2. **Inline review comments** — Posted on specific code lines with:
   - Issue description
   - Suggested fix (code block)
   - Tool attribution (e.g., "ESLint: no-unused-vars")
3. **Pre-merge checks** — GitHub commit status checks (pass/fail) with:
   - Built-in checks (20+ categories)
   - Custom checks (user-defined rules in natural language)
   - Enforcement modes: `report_only`, `request_changes`, `block_merge`

### Autofix (AI-Driven Fixes)

- Triggered via `@coderabbitai autofix` comment on PR
- Processes all **unresolved CodeRabbit review threads** with fix instructions
- Two modes:
  - **Push commit** to current branch
  - **Stacked PR** — opens a separate PR with fixes for independent review
- Checkbox triggers in PR walkthrough comment for one-click autofix
- Currently in beta; only processes threads with structured fix instructions

### "Outside the Diff" — Related Issues

- CodeRabbit uses **knowledge base** features:
  - **Code Guidelines** — project-level rules
  - **Multi-Repo Analysis** — cross-repository context
  - **MCP Servers** — external context sources
  - **Web Search** — fetches relevant docs
- **Slop Detection** — identifies AI-generated code patterns (filler words, redundant comments)
- **CI/CD Pipeline Analysis** — analyzes GitHub Actions, GitLab CI, CircleCI, Azure DevOps logs

### Additional Features

- **Unit test generation** via `@coderabbitai generate unit tests` (creates stacked PR)
- **Merge conflict resolution** via Finishing Touches
- **Custom recipes** — user-defined finishing touch workflows

---

## 2. Greptile

**Website**: https://greptile.com
**Integration model**: GitHub App (webhook), also supports GitLab, self-hosting (Docker Compose / Kubernetes)
**Docs**: https://www.greptile.com/docs

### How It Works — Graph-Based Context

Greptile builds a **complete graph of the codebase** (functions, classes, imports, dependencies) and uses it during reviews:
- **Codebase Indexing** — parses all code into a dependency graph
- **Function Dependencies** — traces what each function calls
- **Function Usage** — identifies all callers of changed code
- **Pattern Consistency** — checks if changes follow established patterns
- **Impact Analysis** — identifies all code affected by changes (the "outside the diff" feature)

### Comment Format

1. **PR Summary** (posted as a single comment):
   - Plain-language explanation of what the PR does
   - Who it affects and why
   - Major improvements and issues found
   - **Confidence Score** (0-5 scale)
   - **Files Changed & Issues** — file-by-file breakdown
   - **Diagrams** — auto-generated (sequence, flowchart, entity-relationship, state)

2. **Inline Comments** (on specific code lines):
   - **Comment Types**: bug, security, performance, style, documentation
   - **Suggested Fixes** — code blocks with proposed changes
   - Threaded conversation support (reply, resolve via GitHub API)

### Confidence Score (0-5)

| Score | Meaning | Action |
|-------|---------|--------|
| 5/5 | Production ready | Merge |
| 4/5 | Minor polish needed | Merge after small fixes |
| 3/5 | Implementation issues | Address feedback first |
| 2/5 | Significant bugs | Needs rework |
| 0-1/5 | Critical problems | Major rethink needed |

Calculated based on: severity/quantity of issues, complexity of changes, alignment with codebase patterns. Scores are **contextual** (3/5 on payments is more serious than 3/5 on an internal script).

### Memory & Learning System

- **Reads team comments on PRs** — learns team preferences
- **Thumbs up/down reactions** — instant feedback on suggestion quality
- **Commit-based learning** — compares first and last commits to see which comments were addressed
- **Adaptive noise filtering** — suppresses repeatedly-ignored suggestions (e.g., stops semicolon comments after 3 ignores, but never suppresses security issues)
- **Custom Rules** — team-defined rules enforced consistently
- **Nitpick Reduction** — learns team's tolerance for minor suggestions

### Integration Model

- GitHub App (primary)
- MCP server support
- Slack/Jira/Linear integrations
- Self-hostable (Docker Compose, Kubernetes)

---

## 3. Qodo (formerly CodiumAI) / PR-Agent

**Website**: https://qodo.ai (commercial) / https://github.com/qodo-ai/pr-agent (open source)
**Integration model**: GitHub App, GitHub Action, GitLab, Bitbucket, Azure DevOps, Gitea, CLI
**Docs**: https://qodo-merge-docs.qodo.ai/

### PR Review Tools

PR-Agent provides **separate commands** for different review aspects:

| Command | Purpose |
|---------|---------|
| `/describe` | Auto-generate PR description, labels, title |
| `/review` | Scan code changes, generate structured feedback |
| `/improve` | Generate actionable code improvement suggestions |
| `/ask` | Ask questions about the PR (including on specific code lines) |
| `/add_docs` | Generate documentation for changed code |
| `/generate_labels` | Auto-label PR by content type |
| `/similar_issues` | Find related issues in the repo |
| `/update_changelog` | Auto-update CHANGELOG |

### Review Output (`/review`)

- **Persistent comment** — edits previous review comment on each re-run (reduces noise)
- Structured sections:
  - Estimated effort to review (1-5 scale)
  - Security concerns
  - Key issues and suggestions
  - General feedback

### Improve Output (`/improve`)

- **Two presentation modes**:
  1. **Table mode** (default, recommended) — collapsible table with:
     - One-liner summary per suggestion
     - Impact level (critical, high, medium, low)
     - Clickable "more" for details
     - Implementation status tracking
     - IDE integration for applying suggestions
  2. **Committable code comments** — inline GitHub suggestions that can be committed with one click
- **Dual publishing mode** — high-score suggestions appear both in table AND as committable comments
- **Chunking** — splits large PRs into chunks, generates up to 3 suggestions per chunk (scales with PR size)
- Categories: security, quality, performance, best practices, maintainability

### Auto-Detection

- Analyzes PR diff to determine language and framework
- Adapts suggestions to project conventions
- Supports custom `extra_instructions` per command

### Key Differentiators

- **Open source** core (PR-Agent) with commercial offering (Qodo Merge)
- **Compression strategy** — adaptive token-aware file patch fitting for large PRs
- **Dynamic context** — pulls relevant non-diff code for context
- **Chat on suggestions** — interactive follow-up on code suggestions
- **Self-reflection** — AI validates its own suggestions before posting

---

## 4. SonarCloud / SonarQube

**Website**: https://sonarcloud.io (cloud) / https://www.sonarqube.org (self-hosted)
**Integration model**: GitHub Action / CI scanner + PR decoration
**Docs**: https://docs.sonarsource.com/sonarcloud/

### Issue Types

| Type | Description |
|------|-------------|
| **Bug** | Code that is demonstrably wrong or will cause unexpected behavior |
| **Vulnerability** | Security flaw that could be exploited |
| **Code Smell** | Maintainability issue that makes code harder to understand/change |
| **Security Hotspot** | Code that requires manual security review (not necessarily a vulnerability) |

### Severity Levels

- **Blocker** — Must fix immediately
- **Critical** — Must fix
- **Major** — Should fix
- **Minor** — Nice to fix
- **Info** — Informational

### Quality Gates

Quality gates define a set of conditions that code must meet before it can be merged. Applied to **new code** (code changed in the PR):

- **Default conditions**: Coverage on new code, duplicated lines, reliability rating, security rating, maintainability rating
- **Custom conditions**: Teams can define their own metric thresholds
- **Pass/Fail** — binary result posted as GitHub commit status check
- **Enforcement**: Can block merge via branch protection rules

### PR Integration

- **PR Decoration** — Posts analysis results directly on the PR:
  - Summary comment with quality gate status
  - Inline annotations on specific code lines
  - Links to SonarCloud dashboard for detailed analysis
- **Automatic analysis** — triggered on every push/PR via CI pipeline
- Supports: GitHub, GitLab, Bitbucket Cloud, Azure DevOps

### AI Capabilities (2026)

- **AI Code Assurance** — standards for AI-generated code
- **Agentic Analysis** — AI-assisted vulnerability verification
- **Remediation Agent** — AI-suggested fixes for detected issues
- **Context Augmentation** — enriches analysis with codebase context

### Key Differentiator

- **Rule-based deterministic analysis** — not AI/LLM-based for core detection (unlike CodeRabbit/Greptile)
- **5,000+ rules** across 30+ languages
- **Technical debt estimation** in time units
- **Code coverage integration** — tracks test coverage on new code

---

## 5. Kilo Code

**Website**: https://kilocode.ai
**Integration model**: VS Code extension, JetBrains extension, CLI, Cloud Agent, Mobile, Slack
**Docs**: https://kilocode.ai/docs

### Code Review Capabilities

Kilo Code is primarily an **AI coding agent** (fork of Cline/Roo Code), not a dedicated PR review tool. Its review-adjacent features:

- **Code Actions** (VS Code integration):
  - "Explain Code" — asks AI to explain selected code
  - "Fix Code" — asks AI to fix problems in selected code
  - "Improve Code" — asks AI to suggest improvements
  - "Add to Context" — adds code to active chat session
- **Multiple Agent Modes** — Code, Ask, Plan, Debug, and custom agents
- **No dedicated PR review agent** — review is done through general-purpose chat/agent interactions
- **Orchestrator Mode** — can coordinate multi-step tasks (now built into all agents)

### Key Observation

Kilo Code does **not** have a built-in code review agent comparable to CodeRabbit or Greptile. Its approach is to use general-purpose AI agents that can be pointed at code for review-like tasks. No PR integration, no inline commenting on GitHub, no confidence scoring.

---

## 6. OpenCode

**Website**: https://github.com/opencode-ai/opencode (archived Sep 2025)
**Integration model**: Terminal-based AI coding agent (Go + Bubble Tea TUI)

### Capabilities

- **Interactive TUI** — terminal-based AI coding assistant
- **Multiple AI Providers** — OpenAI, Anthropic, Gemini, AWS Bedrock, Groq, Azure, OpenRouter
- **Tool Integration** — bash execution, file read/write/edit, grep, glob, diagnostics
- **LSP Integration** — Language Server Protocol for code intelligence
- **Session Management** — persistent SQLite storage
- **Sub-agent spawning** — `agent` tool for delegating sub-tasks

### Code Review

OpenCode has **no dedicated code review feature**. It is a general-purpose AI coding agent similar to Claude Code. Review would be done by asking the AI to analyze code changes in a conversational manner. The project was **archived** in September 2025.

---

## 7. Cursor

**Website**: https://cursor.com
**Integration model**: IDE (VS Code fork) with built-in AI

### Review Capabilities

Cursor is an **AI-powered IDE**, not a code review tool. Its review-adjacent features:

- **Inline AI chat** — ask questions about selected code
- **Code generation and editing** — AI-powered code changes
- **Tab completion** — AI autocomplete
- **No PR review integration** — does not post comments on GitHub PRs
- **No confidence scoring or quality gates**
- **Bug Finder** (experimental) — scans codebase for potential bugs, but this is IDE-local, not PR-integrated

Cursor's approach is **pre-review**: helping developers write better code before it reaches the PR stage, rather than reviewing PRs after they are opened.

---

## Cross-Tool Comparison Matrix

| Feature | CodeRabbit | Greptile | Qodo/PR-Agent | SonarCloud | Kilo Code | OpenCode | Cursor |
|---------|-----------|----------|---------------|------------|-----------|----------|--------|
| **PR summary comment** | Yes | Yes | Yes | Yes (quality gate) | No | No | No |
| **Inline code comments** | Yes | Yes | Yes (table + inline) | Yes | No | No | No |
| **Confidence score** | No (pass/fail checks) | Yes (0-5) | Yes (effort 1-5) | No (pass/fail) | No | No | No |
| **Outside-diff analysis** | Yes (knowledge base) | Yes (graph-based) | Yes (dynamic context) | Partial (rules) | No | No | No |
| **Auto-fix suggestions** | Yes (autofix) | Yes (suggested fixes) | Yes (committable) | Yes (remediation agent) | No | No | No |
| **AI-powered fix execution** | Yes (commits fixes) | No | Yes (one-click commit) | Partial (agent) | No | No | No |
| **Linter integration** | 50 tools | No (AI-only) | No (AI-only) | 5000+ rules built-in | No | No | No |
| **Stack auto-detection** | Yes (file-based) | Yes (repo indexing) | Yes (diff analysis) | Yes (scanner config) | No | No | No |
| **Learning/memory** | No | Yes (reactions, commits) | No | No | No | No | No |
| **Self-hostable** | No | Yes | Yes (open source) | Yes (SonarQube) | Yes (open source) | Yes | No |
| **Integration model** | GitHub App | GitHub App | App/Action/CLI | CI + PR decoration | IDE extension | Terminal agent | IDE |

---

## How Auto-Detection of Project Stack Works (Industry Pattern)

### The Common Approach

All tools that auto-detect project stack use the same fundamental pattern:

1. **Scan repository root** for marker files:
   - `package.json` → JavaScript/TypeScript → ESLint, Biome, Prettier
   - `pyproject.toml` / `setup.py` / `requirements.txt` → Python → Ruff, Pylint, Mypy
   - `go.mod` → Go → golangci-lint
   - `Cargo.toml` → Rust → Clippy
   - `Gemfile` → Ruby → RuboCop
   - `composer.json` → PHP → PHPCS, PHPStan, PHPMD
   - `Dockerfile` → Docker → Hadolint
   - `.github/workflows/` → GitHub Actions → Actionlint
   - `*.tf` → Terraform → TFLint, Checkov

2. **Check for tool-specific config files**:
   - `.eslintrc.*` → ESLint already configured
   - `pyproject.toml` with `[tool.ruff]` → Ruff configured
   - `.golangci.yml` → golangci-lint configured
   - `.swiftlint.yml` → SwiftLint configured

3. **Enable by default, respect existing config**:
   - CodeRabbit enables all 50 tools by default; irrelevant ones produce no output
   - Tool config files override default rules

### Industry Standard Tools Per Language

| Language | Linting | Formatting | Security | Type Checking |
|----------|---------|------------|----------|---------------|
| **JavaScript/TS** | ESLint, Biome, Oxlint | Prettier, Biome | Semgrep, npm audit | TypeScript compiler |
| **Python** | Ruff, Pylint, Flake8 | Ruff, Black | Bandit, Semgrep | Mypy, Pyright |
| **Go** | golangci-lint | gofmt | gosec, Semgrep | Go compiler |
| **Rust** | Clippy | rustfmt | cargo-audit | Rust compiler |
| **Ruby** | RuboCop | RuboCop | Brakeman | Sorbet |
| **PHP** | PHPCS, PHPMD | PHP-CS-Fixer | Semgrep | PHPStan |
| **Java** | Checkstyle, PMD | google-java-format | SpotBugs, Semgrep | Java compiler |
| **Kotlin** | Detekt, Ktlint | Ktlint | Detekt security | Kotlin compiler |
| **Swift** | SwiftLint | SwiftFormat | — | Swift compiler |
| **C/C++** | Clang, Cppcheck | clang-format | Semgrep | Clang |
| **Infrastructure** | Actionlint, Hadolint, TFLint | — | Checkov, Trivy, Gitleaks | — |

### How CodeRabbit Achieves 50 Tools

It is a **curated list per language**, not dynamic discovery. Each tool is:
- Pinned to a specific version (e.g., ESLint v9.28.0, Ruff v0.15.7)
- Run in a sandboxed environment on CodeRabbit's infrastructure
- Results are mapped to file/line positions and presented as inline review comments
- Users can enable/disable individually via `.coderabbit.yaml`

---

## Key Takeaways for Forge's `/review` System

### 1. Comment Architecture (Best Practice)

- **Summary comment** — one top-level PR comment with overview, files changed, diagrams
- **Inline comments** — on specific code lines for actionable issues
- **Confidence/effort score** — numeric rating for quick triage (Greptile's 0-5, Qodo's 1-5)
- **Categories per comment** — bug, security, performance, style (Greptile pattern)

### 2. Fix Suggestions (Best Practice)

- **Code block suggestions** — show the fix inline (all tools do this)
- **Committable suggestions** — one-click commit via GitHub suggestion syntax (Qodo)
- **Autofix agent** — AI commits fixes to branch or stacked PR (CodeRabbit)
- **Dual publishing** — high-severity items get both table entry AND inline comment (Qodo)

### 3. Outside-the-Diff Analysis (Best Practice)

- **Graph-based** — build dependency graph, trace callers/callees of changed code (Greptile)
- **Knowledge base** — index project docs, guidelines, patterns (CodeRabbit)
- **Dynamic context** — pull relevant unchanged code into AI context (Qodo)

### 4. Tool Integration Tiers

For Forge, a practical approach would be:

| Tier | Scope | Tools |
|------|-------|-------|
| **Tier 1: Always** | Universal | TypeScript compiler, ESLint, Prettier/Biome |
| **Tier 2: Project** | Auto-detected | Ruff (Python), Clippy (Rust), golangci-lint (Go) |
| **Tier 3: Security** | Always | Gitleaks (secrets), npm audit / OSV Scanner |
| **Tier 4: AI** | Always | LLM review (logic, patterns, best practices) |

### 5. Learning & Noise Reduction

- Greptile's approach is the gold standard: **learn from reactions, suppress repeatedly-ignored suggestions**
- Minimum viable: track which review comments get addressed vs ignored across PRs
- Custom rules (both Greptile and CodeRabbit) let teams encode their own standards
