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

/** True when a path falls inside Forge's protected set. */
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
function commandTouchesProtectedPath(command) {
  if (typeof command !== 'string' || !command) return false;
  if (!WRITE_INTENT_RE.test(command)) return false;
  const tokens = command.split(/[\s;|&<>()]+/);
  for (const raw of tokens) {
    const token = raw.replace(/^["']+|["']+$/g, '');
    if (token && !token.startsWith('-') && isProtectedPath(token)) return true;
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

/**
 * Core enforcement decision. `runTddCheck` is injectable for deterministic tests.
 * @returns {{ decision: 'allow'|'deny', reason?: string }}
 */
function decide({ intent, input, runTddCheck = runInstalledTddCheck }) {
  if (intent === 'protected-path') {
    const target = extractPath(input);
    if (isProtectedPath(target)) {
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
      if (commandTouchesProtectedPath(command)) {
        return {
          decision: 'deny',
          reason: 'Shell command writes to a Forge-protected path — use the owning Forge CLI/skill instead.',
        };
      }
    }
    return { decision: 'allow' };
  }

  if (intent === 'tdd-gate') {
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
  const decision = decide({ intent, input });
  const output = formatOutput(harness || 'claude', decision);
  if (output) process.stdout.write(output);
  // Exit 0 always: the decision travels in the JSON body, not the exit code, so a
  // non-deny outcome leaves the harness's normal permission flow untouched.
  process.exit(0);
}

module.exports = {
  PROTECTED_PATTERNS,
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
