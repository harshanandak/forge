# AI Coding Agent Detection Research

> **Date**: 2026-03-22
> **Purpose**: How to detect AI coding agents from within a Node.js CLI tool
> **Primary Prior Art**: `@vercel/detect-agent` v1.2.1 (5M+ monthly npm downloads, Apache-2.0)
> **Source**: https://github.com/vercel/vercel/tree/main/packages/detect-agent

---

## 1. Environment Variables by Agent

### 1a. Verified from Live Environment (this machine right now)

These env vars were captured from the actual running process (Claude Code inside Cursor):

| Variable | Value (observed) | Set By |
|----------|-----------------|--------|
| `CLAUDE_CODE_ENTRYPOINT` | `claude-vscode` | Claude Code |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | `true` | Claude Code |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | Claude Code |
| `CLAUDE_AGENT_SDK_VERSION` | `0.2.81` | Claude Agent SDK |
| `CLAUDE_PROJECT_DIR` | `C:\Users\...\context-mode\1.0.25` | Claude Code |
| `CLAUDE_PLUGIN_ROOT` | `C:\Users\...\context-mode\1.0.25` | Claude Code |
| `CLAUDE_PLUGIN_DATA` | `C:\Users\...\.claude\plugins\data\context-mode-context-mode` | Claude Code |
| `CURSOR_TRACE_ID` | `d4b9681f6ee24469a16aaf0398ea1cff` | Cursor |
| `CURSOR_EXTENSION_HOST_ROLE` | `user` | Cursor |
| `CURSOR_WORKSPACE_LABEL` | `forge` | Cursor |
| `VSCODE_PID` | `53392` | VSCode/Cursor (fork) |
| `VSCODE_CLI` | `1` | VSCode/Cursor |
| `VSCODE_CWD` | `C:\Windows\System32` | VSCode/Cursor |
| `VSCODE_IPC_HOOK` | `\\.\pipe\ebc9c05f-2.6.20-main-sock` | VSCode/Cursor |
| `VSCODE_ESM_ENTRYPOINT` | `vs/workbench/api/node/extensionHostProcess` | VSCode/Cursor |
| `VSCODE_CODE_CACHE_PATH` | `...\Cursor\CachedData\...` | Cursor |
| `VSCODE_NLS_CONFIG` | JSON with `cursor` in paths | Cursor |
| `VSCODE_PROCESS_TITLE` | `extension-host (user) forge [1-1]` | VSCode/Cursor |
| `VSCODE_CRASH_REPORTER_PROCESS_TYPE` | `extensionHost` | VSCode/Cursor |
| `VSCODE_HANDLES_UNCAUGHT_ERRORS` | `true` | VSCode/Cursor |

### 1b. From `@vercel/detect-agent` Source (verified from GitHub)

Source: `packages/detect-agent/src/index.ts` in the Vercel monorepo.

| Agent | Env Var(s) | Detection Logic |
|-------|-----------|-----------------|
| **Any agent** (universal) | `AI_AGENT` | Checked first. Value = agent name string. |
| **Cursor** (editor) | `CURSOR_TRACE_ID` | Present when running in Cursor terminal |
| **Cursor** (CLI) | `CURSOR_AGENT` | Present when running via `cursor-cli` |
| **Claude Code** | `CLAUDECODE` or `CLAUDE_CODE` | Either triggers detection |
| **Claude Code + Cowork** | `CLAUDE_CODE_IS_COWORK` | If set alongside CLAUDE_CODE, agent = `cowork` |
| **Gemini CLI** | `GEMINI_CLI` | Google's Gemini CLI |
| **Codex** (OpenAI) | `CODEX_SANDBOX` or `CODEX_CI` or `CODEX_THREAD_ID` | Any of the three |
| **Antigravity** | `ANTIGRAVITY_AGENT` | Google DeepMind agent |
| **Augment CLI** | `AUGMENT_AGENT` | Augment Code CLI |
| **OpenCode** | `OPENCODE_CLIENT` | OpenCode agent |
| **GitHub Copilot** | `COPILOT_MODEL` or `COPILOT_ALLOW_ALL` or `COPILOT_GITHUB_TOKEN` | Or via `AI_AGENT=github-copilot` |
| **Replit** | `REPL_ID` | Replit online IDE |
| **Devin** | (filesystem check) | Checks for `/opt/.devin` directory |

**Detection priority order** (first match wins):
1. `AI_AGENT` (universal standard)
2. `CURSOR_TRACE_ID`
3. `CURSOR_AGENT`
4. `GEMINI_CLI`
5. `CODEX_SANDBOX` / `CODEX_CI` / `CODEX_THREAD_ID`
6. `ANTIGRAVITY_AGENT`
7. `AUGMENT_AGENT`
8. `OPENCODE_CLIENT`
9. `CLAUDECODE` / `CLAUDE_CODE` (with `CLAUDE_CODE_IS_COWORK` sub-check)
10. `REPL_ID`
11. `COPILOT_MODEL` / `COPILOT_ALLOW_ALL` / `COPILOT_GITHUB_TOKEN`
12. `/opt/.devin` filesystem check

### 1c. Additional Claude Code Env Vars (from live + source analysis)

Beyond the detection vars, Claude Code sets these (useful for deeper introspection):

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_ENTRYPOINT` | How Claude was launched: `claude-vscode`, `cli`, etc. |
| `CLAUDE_AGENT_SDK_VERSION` | SDK version (e.g., `0.2.81`) |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | Feature flag |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Feature flag |
| `CLAUDE_PROJECT_DIR` | Working directory for the plugin |
| `CLAUDE_PLUGIN_ROOT` | Plugin installation root |
| `CLAUDE_PLUGIN_DATA` | Plugin data directory |

### 1d. Additional OpenCode Env Vars (from source: `flag.ts`)

| Variable | Type | Purpose |
|----------|------|---------|
| `OPENCODE_CLIENT` | string | The detection var (used by `@vercel/detect-agent`) |
| `OPENCODE_CONFIG` | string | Config file path |
| `OPENCODE_CONFIG_DIR` | string | Config directory |
| `OPENCODE_CONFIG_CONTENT` | string | Inline config content |
| `OPENCODE_AUTO_SHARE` | boolean | Auto-share flag |
| `OPENCODE_GIT_BASH_PATH` | string | Git bash path override |
| `OPENCODE_PERMISSION` | string | Permission level |
| `OPENCODE_DISABLE_MODELS_FETCH` | boolean | Feature flag |
| `OPENCODE_DISABLE_CLAUDE_CODE` | boolean | Disable Claude Code integration |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | boolean | Disable skills |
| `OPENCODE_EXPERIMENTAL` | boolean | Experimental features |
| `OPENCODE_SERVER_PASSWORD` | string | Server auth |

### 1e. VSCode-Specific Env Vars (all VSCode-based editors)

These are set by any VSCode fork (Cursor, Windsurf, Cline/Roo via extension host):

| Variable | Purpose | Distinguishing |
|----------|---------|----------------|
| `VSCODE_PID` | VSCode process ID | Present in all VSCode forks |
| `VSCODE_CLI` | Set to `1` in integrated terminal | |
| `VSCODE_CWD` | VSCode working directory | |
| `VSCODE_IPC_HOOK` | IPC socket path | |
| `VSCODE_ESM_ENTRYPOINT` | Entry point module | |
| `VSCODE_CODE_CACHE_PATH` | Cache path -- **contains editor name** | Path includes `Cursor`, `Windsurf`, or `Code` |
| `VSCODE_NLS_CONFIG` | Localization config JSON -- **contains editor paths** | JSON references editor-specific paths |
| `VSCODE_PROCESS_TITLE` | Process title | |
| `VSCODE_CRASH_REPORTER_PROCESS_TYPE` | `extensionHost` when agent runs as extension | |
| `VSCODE_GIT_ASKPASS_NODE` | Git credential helper path | |
| `VSCODE_GIT_ASKPASS_MAIN` | Git credential helper main | |
| `VSCODE_GIT_IPC_HANDLE` | Git IPC handle | |

**Key insight**: To distinguish Cursor from VSCode from Windsurf, parse `VSCODE_CODE_CACHE_PATH` or `VSCODE_NLS_CONFIG` for the editor name in the filesystem path.

### 1f. Agents NOT Detectable via Env Vars

These agents run as **VSCode extensions** and do NOT set their own env vars. They can only be detected via config file signatures:

| Agent | Why No Env Var | Detection Method |
|-------|---------------|-----------------|
| **Cline** | VSCode extension, no custom env | `.clinerules` or `.clinerules/` directory |
| **Roo Code** | VSCode extension (Cline fork) | `.roo/` directory, `.roo/rules/*.md` |
| **Kilocode** | VSCode extension (Cline fork) | `.kilocode/` directory (unconfirmed -- very new fork) |
| **Windsurf** | Closed-source editor | `.windsurfrules` or `.windsurf/rules/` -- no confirmed env var |
| **Aider** | Terminal CLI, no env var | `.aider.conf.yml`, `CONVENTIONS.md` |
| **Continue.dev** | VSCode extension | `.continue/`, `.continue/rules/*.md` |
| **Amazon Q** | VSCode extension | `.amazonq/` directory |

---

## 2. Config File Signatures

### Complete Map of Agent Config Files

| Agent | Root Rule File | Rule Directory | Settings/Config | Memory File |
|-------|---------------|---------------|-----------------|-------------|
| **Claude Code** | `CLAUDE.md` | `.claude/rules/*.md` | `.claude/settings.json` | `.claude/MEMORY.md` (user-level) |
| **Cursor** | `.cursorrules` (legacy) | `.cursor/rules/*.mdc` | `.cursor/settings.json` | `.cursor/MEMORY.md` |
| **Windsurf** | `.windsurfrules` | `.windsurf/rules/*.md` | -- | -- |
| **Cline** | `.clinerules` | `.clinerules/*.md` | `.cline/` (VSCode storage) | -- |
| **Roo Code** | -- | `.roo/rules/*.md` | `.roo/` | -- |
| **Kilocode** | -- | `.kilocode/rules/*.md` (unconfirmed) | `.kilocode/` (unconfirmed) | -- |
| **GitHub Copilot** | `.github/copilot-instructions.md` | -- | -- | -- |
| **OpenAI Codex** | `codex.md` or `AGENTS.md` | -- | `.codex/` | -- |
| **Gemini CLI** | `GEMINI.md` | -- | `.gemini/` | -- |
| **Continue.dev** | -- | `.continue/rules/*.md` | `.continue/config.json` | -- |
| **Aider** | `CONVENTIONS.md` | -- | `.aider.conf.yml` | -- |
| **Amazon Q** | -- | -- | `.amazonq/` | -- |
| **Augment** | -- | -- | `.augment/` (unconfirmed) | -- |

### Detection Priority for Config Files

Check most-specific first (unique to one agent), then less specific:

```
High confidence (unique):
  .claude/settings.json        -> Claude Code
  .cursor/rules/*.mdc          -> Cursor (MDC format is unique)
  .windsurfrules               -> Windsurf
  .clinerules                  -> Cline
  .roo/rules/                  -> Roo Code
  .continue/config.json        -> Continue.dev
  .github/copilot-instructions.md -> GitHub Copilot
  .aider.conf.yml              -> Aider
  .amazonq/                    -> Amazon Q

Medium confidence (shared conventions):
  CLAUDE.md                    -> Claude Code (but could be any file)
  AGENTS.md / codex.md         -> Codex CLI
  GEMINI.md                    -> Gemini CLI
  CONVENTIONS.md               -> Aider (generic name)
```

---

## 3. Prior Art and Best Practices

### 3a. `@vercel/detect-agent` (Recommended Foundation)

- **npm**: `@vercel/detect-agent` v1.2.1
- **Downloads**: 5M+ monthly
- **License**: Apache-2.0
- **Zero dependencies**
- **API**:

```typescript
import { determineAgent, KNOWN_AGENTS } from '@vercel/detect-agent';

const { isAgent, agent } = await determineAgent();
// isAgent: boolean
// agent: { name: 'cursor' | 'claude' | 'codex' | ... } | undefined
```

- **Key design decisions**:
  - Async (because Devin requires filesystem check)
  - Priority-ordered (first match wins)
  - Promotes `AI_AGENT` as universal standard

### 3b. The `AI_AGENT` Standard (Proposed by Vercel)

Vercel is promoting `AI_AGENT` as a universal environment variable:
- Any AI tool should set `AI_AGENT=<agent-name>`
- Recommended naming: lowercase, hyphenated (e.g., `github-copilot`)
- Checked first in detection priority
- Allows unknown/future agents to self-identify

### 3c. `ci-info` / `is-ci` Pattern (CI Detection Analogy)

- **npm**: `ci-info` (Watson) -- same pattern for CI environments
- **Design**: Declarative vendor list in `vendors.json`
- Each vendor: `{ name, constant, env, pr }`
- Detection: iterate vendors, check `process.env[vendor.env]`
- `is-ci` is a one-liner wrapper: `module.exports = require('ci-info').isCI`

This is the exact same pattern `@vercel/detect-agent` follows for AI agents.

### 3d. `supports-color` / `is-interactive` / `is-unicode-supported`

These Sindre Sorhus packages (100M+ monthly downloads each) detect terminal capabilities:
- `is-interactive`: checks `process.stdout.isTTY`
- `supports-color`: checks `TERM`, `COLORTERM`, `CI`, `TERM_PROGRAM`
- Relevant because AI agents often run with `isTTY = false`

### 3e. VSCode-based Editor Detection via PATH/Cache Paths

When `VSCODE_PID` is set but no agent-specific var exists, parse paths:

```typescript
function detectVSCodeEditor(): string | null {
  const cachePath = process.env.VSCODE_CODE_CACHE_PATH || '';
  const nlsConfig = process.env.VSCODE_NLS_CONFIG || '';

  if (cachePath.includes('Cursor') || nlsConfig.includes('cursor')) return 'cursor';
  if (cachePath.includes('Windsurf') || nlsConfig.includes('windsurf')) return 'windsurf';
  if (cachePath.includes('Code') || nlsConfig.includes('Code')) return 'vscode';
  return null;
}
```

---

## 4. Incremental CLI Setup Patterns

### 4a. Terraform `init`

- **Lockfile**: `.terraform.lock.hcl` -- records provider versions
- **State dir**: `.terraform/` -- caches provider plugins
- **Re-run behavior**: Safe to re-run. Updates backend config only with `-reconfigure` or `-migrate-state`
- **Idempotent**: Skips already-downloaded providers, only fetches missing ones

### 4b. Yeoman Generators

- **Conflicter**: When generating into existing directory, per-file conflict resolution
- **Options**: `--force` (overwrite all), `--skip` (skip existing), interactive (Y/n/a/d per file)
- **`mem-fs-editor`**: Virtual filesystem -- stages all changes, commits at end
- **Conflict check**: Compares content hash, skips identical files

### 4c. Angular CLI Schematics

- **Tree abstraction**: Virtual filesystem tree
- **Merge strategies**: `MergeStrategy.Error`, `MergeStrategy.Overwrite`, `MergeStrategy.ContentOnly`
- **Update schematics**: `ng update` runs migration schematics that make targeted edits
- **`RecordedTree`**: Records all changes as a set of `Create`, `Delete`, `Rename`, `Overwrite` operations

### 4d. Rails Generators

- **Per-file actions**: `create`, `identical`, `skip`, `force`, `conflict`
- **`--skip`**: Skip files that already exist
- **`--force`**: Overwrite without asking
- **`--pretend`**: Dry-run, show what would happen
- **`--diff`**: Show diff for conflicting files
- **Identical detection**: SHA comparison, prints `identical` and skips

### 4e. Marker-Based File Sections

Used by tools that manage sections within user-editable files:

```
# === BEGIN FORGE MANAGED ===
# Do not edit this section manually
PATH="/some/generated/path:$PATH"
# === END FORGE MANAGED ===
```

- **Pattern**: `BEGIN <TOOL> MANAGED` / `END <TOOL> MANAGED`
- **Used by**: Homebrew (shellenv), nvm (.bashrc), direnv, asdf
- **Implementation**: Read file, find markers, replace content between them, preserve rest
- **Benefit**: Re-runnable. User edits outside markers are preserved.

### 4f. Composite Pattern for CLI `setup` Re-runs

Best practice from multiple tools:

```typescript
interface SetupStep {
  name: string;
  check: () => Promise<boolean>;  // Already done?
  run: () => Promise<void>;       // Do it
  force?: boolean;                // Override check
}

async function setup(steps: SetupStep[], options: { force: boolean }) {
  for (const step of steps) {
    if (!options.force && await step.check()) {
      console.log(`  [skip] ${step.name} (already configured)`);
      continue;
    }
    console.log(`  [run]  ${step.name}`);
    await step.run();
  }
}
```

Key principles:
1. **Each step is independently idempotent** -- has its own `check()`
2. **`--force` flag** bypasses all checks
3. **Granular skip messages** tell user what was skipped and why
4. **No destructive re-runs** -- default behavior preserves existing config

---

## 5. Recommended Detection Implementation

### Combined Strategy: Env Vars + Config Files

```typescript
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

interface AgentInfo {
  name: string;
  source: 'env' | 'config' | 'path' | 'none';
  confidence: 'high' | 'medium' | 'low';
  details?: Record<string, string>;
}

// --- Layer 1: Environment variable detection (fast, high confidence) ---

function detectAgentFromEnv(): AgentInfo | null {
  const env = process.env;

  // Universal standard (proposed by Vercel)
  if (env.AI_AGENT) {
    return { name: env.AI_AGENT.trim(), source: 'env', confidence: 'high' };
  }

  // Claude Code
  if (env.CLAUDECODE || env.CLAUDE_CODE) {
    const name = env.CLAUDE_CODE_IS_COWORK ? 'cowork' : 'claude';
    return {
      name,
      source: 'env',
      confidence: 'high',
      details: {
        entrypoint: env.CLAUDE_CODE_ENTRYPOINT || 'unknown',
        sdkVersion: env.CLAUDE_AGENT_SDK_VERSION || 'unknown',
      },
    };
  }

  // Cursor
  if (env.CURSOR_TRACE_ID) {
    return { name: 'cursor', source: 'env', confidence: 'high' };
  }
  if (env.CURSOR_AGENT) {
    return { name: 'cursor-cli', source: 'env', confidence: 'high' };
  }

  // Gemini CLI
  if (env.GEMINI_CLI) {
    return { name: 'gemini', source: 'env', confidence: 'high' };
  }

  // Codex (OpenAI)
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_THREAD_ID) {
    return { name: 'codex', source: 'env', confidence: 'high' };
  }

  // Antigravity (Google DeepMind)
  if (env.ANTIGRAVITY_AGENT) {
    return { name: 'antigravity', source: 'env', confidence: 'high' };
  }

  // Augment CLI
  if (env.AUGMENT_AGENT) {
    return { name: 'augment-cli', source: 'env', confidence: 'high' };
  }

  // OpenCode
  if (env.OPENCODE_CLIENT) {
    return { name: 'opencode', source: 'env', confidence: 'high' };
  }

  // GitHub Copilot
  if (env.COPILOT_MODEL || env.COPILOT_ALLOW_ALL || env.COPILOT_GITHUB_TOKEN) {
    return { name: 'github-copilot', source: 'env', confidence: 'high' };
  }

  // Replit
  if (env.REPL_ID) {
    return { name: 'replit', source: 'env', confidence: 'high' };
  }

  return null;
}

// --- Layer 2: VSCode editor detection via path inspection ---

function detectEditorFromVSCodeEnv(): string | null {
  const cachePath = process.env.VSCODE_CODE_CACHE_PATH || '';
  const nlsConfig = process.env.VSCODE_NLS_CONFIG || '';
  const combined = `${cachePath} ${nlsConfig}`.toLowerCase();

  if (combined.includes('cursor')) return 'cursor';
  if (combined.includes('windsurf')) return 'windsurf';
  if (combined.includes('code - insiders')) return 'vscode-insiders';
  if (combined.includes('code')) return 'vscode';
  return process.env.VSCODE_PID ? 'vscode-unknown' : null;
}

// --- Layer 3: Config file detection (slower, filesystem I/O) ---

const CONFIG_SIGNATURES = [
  { name: 'claude',          paths: ['.claude/settings.json', 'CLAUDE.md'] },
  { name: 'cursor',          paths: ['.cursor/rules', '.cursorrules'] },
  { name: 'windsurf',        paths: ['.windsurfrules', '.windsurf/rules'] },
  { name: 'cline',           paths: ['.clinerules', '.cline'] },
  { name: 'roo-code',        paths: ['.roo/rules', '.roo'] },
  { name: 'kilocode',        paths: ['.kilocode'] },
  { name: 'github-copilot',  paths: ['.github/copilot-instructions.md'] },
  { name: 'codex',           paths: ['codex.md', '.codex', 'AGENTS.md'] },
  { name: 'gemini',          paths: ['GEMINI.md', '.gemini'] },
  { name: 'continue',        paths: ['.continue/config.json', '.continue/rules'] },
  { name: 'aider',           paths: ['.aider.conf.yml', 'CONVENTIONS.md'] },
  { name: 'amazon-q',        paths: ['.amazonq'] },
  { name: 'augment',         paths: ['.augment'] },
];

function detectAgentsFromConfig(projectRoot: string): string[] {
  const detected: string[] = [];
  for (const sig of CONFIG_SIGNATURES) {
    for (const p of sig.paths) {
      if (existsSync(join(projectRoot, p))) {
        detected.push(sig.name);
        break;
      }
    }
  }
  return detected;
}

// --- Layer 4: TTY / interactivity detection ---

function detectInteractivity(): {
  isTTY: boolean;
  isCI: boolean;
  isAgent: boolean;
} {
  const isTTY = !!(process.stdout.isTTY);
  const isCI = !!(
    process.env.CI ||
    process.env.CONTINUOUS_INTEGRATION ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.BUILDKITE
  );
  const agentResult = detectAgentFromEnv();
  return { isTTY, isCI, isAgent: !!agentResult };
}
```

### Usage in a CLI Setup Command

```typescript
async function detectEnvironment(projectRoot: string) {
  // Fast: env vars (sync, no I/O)
  const agent = detectAgentFromEnv();
  const editor = detectEditorFromVSCodeEnv();
  const { isTTY, isCI } = detectInteractivity();

  // Slower: config files (filesystem I/O)
  const configuredAgents = detectAgentsFromConfig(projectRoot);

  return {
    // The agent currently running this code
    activeAgent: agent?.name || null,
    activeAgentSource: agent?.source || 'none',
    activeAgentDetails: agent?.details || {},

    // The editor hosting the agent
    editor: editor || (isTTY ? 'terminal' : 'unknown'),

    // All agents with config files in this project
    configuredAgents,

    // Interactivity
    isTTY,
    isCI,
    isAgent: !!agent,

    // Behavioral flags
    shouldPrompt: isTTY && !agent && !isCI,
    shouldAutoApprove: !!agent,  // Agents can't answer prompts
  };
}
```

---

## 6. Key Takeaways

1. **Use `@vercel/detect-agent`** as a dependency or reference implementation. It is actively maintained (v1.2.1, March 2026), has 5M+ monthly downloads, and covers 12 agents.

2. **The `AI_AGENT` env var** is becoming a de facto standard. Encourage agents to set it.

3. **Cline, Roo Code, and Kilocode have NO env vars** -- they run as VSCode extensions. Detection is config-file-only.

4. **Windsurf has NO confirmed env var** -- detection relies on `.windsurfrules` / `.windsurf/` or parsing `VSCODE_CODE_CACHE_PATH` for "Windsurf".

5. **VSCode env vars are always present** when running inside any VSCode-based editor. Distinguish the specific editor by parsing `VSCODE_CODE_CACHE_PATH` or `VSCODE_NLS_CONFIG`.

6. **Layer the detection**: env vars (fast, high confidence) -> VSCode path parsing (medium) -> config file existence (slow, detects project setup not active agent).

7. **For CLI setup re-runs**: Use the Terraform/Rails pattern -- each step has an idempotent `check()`, skip if already done, `--force` to override.
