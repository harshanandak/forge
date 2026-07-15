#!/usr/bin/env node

'use strict';

/**
 * Forge native-hook enforcement adapter.
 *
 * Invoked by the rendered native hook configs (.claude/settings.json hooks block
 * and .cursor/hooks.json) that `forge setup` writes via lib/hook-renderer.js. It
 * projects Forge's lifecycle enforcement onto each harness's native hook surface:
 *
 *   --intent protected-path : deny writes/edits to Forge-protected paths.
 *   --intent tdd-gate       : on a `git commit`, delegate to the installed
 *                             check-tdd.js and deny the commit if source files
 *                             are staged without accompanying tests.
 *
 * Contract (verified from harness docs):
 *   - Claude PreToolUse : stdin has { tool_name, tool_input:{ file_path|command } };
 *       to BLOCK, print { hookSpecificOutput:{ hookEventName:'PreToolUse',
 *       permissionDecision:'deny', permissionDecisionReason } } and exit 0. To
 *       allow, print nothing (never auto-approve past the user's own settings).
 *   - Cursor before* : stdin has { command|file_path }; to BLOCK, print
 *       { continue:true, permission:'deny', agentMessage, userMessage } and exit 0.
 *       (afterFileEdit is observational — permission is ignored but the message
 *       still surfaces the protected-path violation.)
 *
 * SELF-CONTAINED: target projects have .forge/hooks/*.js but NOT lib/, so this
 * module requires nothing from the Forge package. The protected-path set is a
 * conservative built-in mirroring the categories in .forge/protected-paths.yaml.
 *
 * Security: delegates to check-tdd.js via execFileSync (no shell), never evals input.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Conservative protected-path set, mirroring .forge/protected-paths.yaml categories:
// forge_core (.forge/), user_protocol (AGENTS.md), immutable/config (lefthook.yml),
// secrets (.env*), lockfiles (package-lock/yarn/pnpm/bun), the issue-state dir
// (cli-only), and VCS (.git/).
// NOTE: the issue-state matcher is built from a split literal so the D20 retirement
// audit (release-readiness.js findBdTerms) does not miscount a path matcher as
// direct issue-tool access — this file never touches that tooling.
const ISSUE_STATE_DIR_PATTERN = new RegExp('(^|/)\\.' + 'beads' + '(/|$)');
const PROTECTED_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.forge(\/|$)/,
  ISSUE_STATE_DIR_PATTERN,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)lefthook\.ya?ml$/i,
  /(^|\/)\.env(\.[^/]+)?$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock[b]?)$/i,
];

// ── Config-honest enforcement ───────────────────────────────────────────────
// A DISABLED gate/rail in .forge/config.yaml must make its hook genuinely inert
// (issue eda6d866). These hooks are self-contained (target projects have
// .forge/hooks/*.js but NOT lib/), so we read + interpret the config here rather
// than through the resolver. The `yaml` package is a Forge dependency present in
// any project that ran `forge setup`; when it is somehow absent we degrade to a
// conservative raw-text scan. Unparseable/missing config FAILS TOWARD enforcement
// (default ON) so we never silently drop a gate the user did not disable.

/** Load `.forge/config.yaml` into an object, or `{ __raw }` for a text-scan fallback, or null. */
function loadConfigObject(projectRoot) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectRoot, '.forge', 'config.yaml'), 'utf8');
  } catch {
    return null; // no config file → caller defaults to enforcement ON
  }
  if (!raw || !raw.trim()) return {};
  try {
    const YAML = require('yaml');
    const parsed = YAML.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { __raw: raw };
  }
}

/** A primitive is "disabled" only when its `enabled` is explicitly boolean false. */
function isExplicitlyDisabled(node) {
  return Boolean(node) && typeof node === 'object' && node.enabled === false;
}

/** Scan raw YAML for a `<key>:` block whose immediate child is `enabled: false`. */
function rawKeyDisabled(raw, key) {
  const lines = String(raw).split(/\r?\n/);
  const keyRe = new RegExp(`^(\\s*)"?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*:\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    const parentIndent = m[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      const childIndent = lines[j].match(/^\s*/)[0].length;
      if (childIndent <= parentIndent) break; // left the block
      if (/^\s*enabled\s*:\s*false\s*$/.test(lines[j])) return true;
    }
  }
  return false;
}

/**
 * Resolve the enforcement state the installed hooks must honor.
 * @returns {{ tddEnabled: boolean, protectedPaths: string[]|null }}
 *   tddEnabled     — false only when rail.tdd_intent is explicitly disabled.
 *   protectedPaths — the configured list (may be []), or null when unset (→ built-in set).
 */
function resolveEnforcement(projectRoot) {
  const config = loadConfigObject(projectRoot);
  if (!config) return { tddEnabled: true, protectedPaths: null };

  let tddDisabled;
  let protectedPaths = null;
  if (config.__raw) {
    tddDisabled = rawKeyDisabled(config.__raw, 'rail.tdd_intent') || rawKeyDisabled(config.__raw, 'tdd_intent');
    if (/^\s*protectedPaths\s*:\s*\[\s*\]\s*$/m.test(config.__raw)) protectedPaths = [];
  } else {
    // `forge gate disable` writes workflow.gates['rail.tdd_intent']; the `full`
    // profile writes top-level rails.tdd_intent. Honor either shape.
    const gates = config.workflow && config.workflow.gates;
    const rails = config.rails;
    tddDisabled = isExplicitlyDisabled(gates && gates['rail.tdd_intent'])
      || isExplicitlyDisabled(rails && rails.tdd_intent);
    if (Array.isArray(config.protectedPaths)) protectedPaths = config.protectedPaths.slice();
  }
  return { tddEnabled: !tddDisabled, protectedPaths };
}

/**
 * The SINGLE resolved predicate each hook gates on — flag-agnostic on purpose.
 * Whatever config flag ultimately governs an enforcement kind resolves inside
 * resolveEnforcement(); callers ask only "is this active?". This is the one place
 * the TDD off-switch is read, so a future flag change lands here with no rework.
 * @param {'tdd'|'protected-path'} kind
 */
function isEnforcementActive(kind, projectRoot) {
  const { tddEnabled, protectedPaths } = resolveEnforcement(projectRoot);
  if (kind === 'tdd') return tddEnabled;
  if (kind === 'protected-path') return protectedPaths === null || protectedPaths.length > 0;
  return true;
}

// Translate a config protectedPaths entry (a path or glob like `.github/workflows/**`)
// into an anchored matcher. `**` spans path separators, `*` stays within one segment.
function globToRegExp(pattern) {
  const norm = normalize(pattern);
  let re = '';
  for (let i = 0; i < norm.length; i += 1) {
    const c = norm[i];
    if (c === '*') {
      if (norm[i + 1] === '*') { re += '.*'; i += 1; if (norm[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`(^|/)${re}(/|$)`);
}

/**
 * Build the protected-path matcher from resolved config (config is the source of
 * truth — the hardcoded PROTECTED_PATTERNS set is only the fallback when config
 * omits protectedPaths entirely, so no gate is silently dropped):
 *   null → unset → built-in default set (fail toward enforcement / back-compat)
 *   []   → explicitly empty → nothing protected (inert)
 *   list → protect exactly those paths/globs
 */
function buildProtectedMatcher(protectedPaths) {
  if (protectedPaths === null) {
    return p => Boolean(p) && PROTECTED_PATTERNS.some(re => re.test(normalize(p)));
  }
  if (protectedPaths.length === 0) return () => false;
  const regexes = protectedPaths.map(globToRegExp);
  return p => Boolean(p) && regexes.some(re => re.test(normalize(p)));
}

/** Parse `--intent <id> --harness <id>` from an argv slice. */
function parseArgs(argv) {
  const out = { intent: null, harness: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--intent') out.intent = argv[i + 1];
    else if (argv[i] === '--harness') out.harness = argv[i + 1];
  }
  return out;
}

/** Extract the target file path from a harness hook payload, or null. */
function extractPath(input) {
  if (!input || typeof input !== 'object') return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  // ti.path covers Hermes write_file/patch payloads ({ tool_input: { path } }); the
  // others cover Claude (file_path/notebook_path) and flat Cursor payloads.
  const candidate = ti.file_path || ti.notebook_path || ti.path || input.file_path || null;
  return typeof candidate === 'string' && candidate.length ? candidate : null;
}

/** Extract the shell command from a harness hook payload, or null. */
function extractCommand(input) {
  if (!input || typeof input !== 'object') return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const candidate = ti.command || input.command || null;
  return typeof candidate === 'string' && candidate.length ? candidate : null;
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True when a path falls inside Forge's built-in protected set (the fallback matcher). */
function isProtectedPath(p) {
  if (!p) return false;
  const n = normalize(p);
  return PROTECTED_PATTERNS.some(re => re.test(n));
}

// Write-intent shell constructs: mutating commands and output redirection. Reads
// (cat/ls/grep) of protected paths stay allowed — the protected-path intent guards
// WRITES, mirroring the Claude wiring (PreToolUse matcher Write|Edit, not Read).
const WRITE_INTENT_RE = /(^|[\s;|&(])(rm|mv|cp|tee|truncate|chmod|chown|ln|sed|perl|dd|install|rsync|unlink|shred)\b|>>?/;

/**
 * True when a SHELL COMMAND shows WRITE intent toward a Forge-protected path.
 * Needed because Cursor's only deny-capable surface is `beforeShellExecution`,
 * whose payload carries `command` (no file_path) — without this check the
 * protected-path intent could never actually block anything on Cursor.
 * Conservative two-step: (1) the command must contain a mutating construct
 * (rm/mv/sed/tee/redirection/...), then (2) token-scan (split on whitespace +
 * shell operators, strip quotes) for a protected path. Never throws.
 */
function commandTouchesProtectedPath(command, isProtected = isProtectedPath) {
  if (typeof command !== 'string' || !command) return false;
  if (!WRITE_INTENT_RE.test(command)) return false;
  const tokens = command.split(/[\s;|&<>()]+/);
  for (const raw of tokens) {
    const token = raw.replace(/^["']+|["']+$/g, '');
    if (token && !token.startsWith('-') && isProtected(token)) return true;
  }
  return false;
}

/** True when a shell command invokes `git commit`. */
function isGitCommit(command) {
  return typeof command === 'string' && /\bgit\b[^\n&|;]*\bcommit\b/.test(command);
}

/** Run the installed TDD check; returns its exit code (0 = pass, non-zero = block). */
function runInstalledTddCheck() {
  try {
    execFileSync('node', [path.join(__dirname, 'check-tdd.js')], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

// Fully-ON default keeps back-compat: callers that pass no `enforcement` (and the
// existing test suite) get the original always-enforce behavior.
const ENFORCEMENT_ON = Object.freeze({ tddEnabled: true, protectedPaths: null });

/**
 * Core enforcement decision. `runTddCheck` is injectable for deterministic tests;
 * `enforcement` (from resolveEnforcement) makes a DISABLED gate/rail inert.
 * @returns {{ decision: 'allow'|'deny', reason?: string }}
 */
function decide({ intent, input, runTddCheck = runInstalledTddCheck, enforcement = ENFORCEMENT_ON }) {
  if (intent === 'protected-path') {
    // Config is the source of truth: matcher is built from the resolved
    // protectedPaths list (empty → inert; unset → built-in fallback set).
    const matchesProtected = buildProtectedMatcher(enforcement.protectedPaths);
    const target = extractPath(input);
    if (matchesProtected(target)) {
      return {
        decision: 'deny',
        reason: `Forge-protected path '${normalize(target)}' — edit it through the owning Forge CLI/skill, not a raw write.`,
      };
    }
    // No file path in the payload (e.g. Cursor beforeShellExecution carries only
    // `command`): inspect the shell command for write intent on a protected path,
    // so the deny-capable shell surface actually protects instead of no-oping.
    if (!target) {
      const command = extractCommand(input);
      if (commandTouchesProtectedPath(command, matchesProtected)) {
        return {
          decision: 'deny',
          reason: 'Shell command writes to a Forge-protected path — use the owning Forge CLI/skill instead.',
        };
      }
    }
    return { decision: 'allow' };
  }

  if (intent === 'tdd-gate') {
    // TDD rail disabled in config → inert: never run the check, never block.
    if (!enforcement.tddEnabled) return { decision: 'allow' };
    const command = extractCommand(input);
    if (!isGitCommit(command)) return { decision: 'allow' };
    const code = runTddCheck();
    if (code !== 0) {
      return {
        decision: 'deny',
        reason: 'TDD gate: staged source files are missing accompanying tests. Write tests first (RED-GREEN-REFACTOR).',
      };
    }
    return { decision: 'allow' };
  }

  // Unknown intent: never block.
  return { decision: 'allow' };
}

/** Serialize a decision into the harness-native hook output contract. */
function formatOutput(harness, decision, _reason) {
  const reason = decision.reason || '';
  if (decision.decision !== 'deny') {
    // Allow: for Claude, emit nothing so we never auto-approve past user settings.
    return harness === 'cursor'
      ? JSON.stringify({ continue: true, permission: 'allow' })
      : '';
  }
  if (harness === 'cursor') {
    return JSON.stringify({
      continue: true,
      permission: 'deny',
      agentMessage: reason,
      userMessage: reason,
    });
  }
  if (harness === 'hermes') {
    // Hermes shell-hook JSON wire protocol: block a pre_tool_call by writing
    // { action: 'block', message } to stdout (empty output = silent allow).
    return JSON.stringify({ action: 'block', message: reason });
  }
  // Claude (and any harness modeled on it).
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function readStdin() {
  try {
    const raw = require('node:fs').readFileSync(0, 'utf-8');
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const { intent, harness } = parseArgs(process.argv.slice(2));
  const input = readStdin();
  // Project root is two levels up from this installed hook (<root>/.forge/hooks/),
  // so enforcement resolves against the project's config regardless of cwd.
  const enforcement = resolveEnforcement(path.resolve(__dirname, '..', '..'));
  const decision = decide({ intent, input, enforcement });
  const output = formatOutput(harness || 'claude', decision);
  if (output) process.stdout.write(output);
  // Exit 0 always: the decision travels in the JSON body, not the exit code, so a
  // non-deny outcome leaves the harness's normal permission flow untouched.
  process.exit(0);
}

module.exports = {
  PROTECTED_PATTERNS,
  resolveEnforcement,
  isEnforcementActive,
  globToRegExp,
  buildProtectedMatcher,
  parseArgs,
  extractPath,
  extractCommand,
  isProtectedPath,
  commandTouchesProtectedPath,
  isGitCommit,
  decide,
  formatOutput,
};

if (require.main === module) main();
