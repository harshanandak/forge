'use strict';

/**
 * Native SAFETY-surface renderer.
 *
 * Renders sane, non-surprising security defaults into the two safety surfaces
 * Forge can write PROJECT-LOCALLY today:
 *
 *   - Claude Code : `.claude/settings.json` -> `permissions` (allow/deny/ask)
 *   - Cursor      : `.cursorignore`         (gitignore-style AI read/index boundary)
 *
 * Both use read -> merge -> write (idempotent, preserves user entries). An existing
 * `.claude/settings.json` that cannot be parsed is BACKED UP and left untouched
 * (mirrors the MCP renderer's data-loss guard) rather than clobbering user settings.
 *
 * NOT rendered here (honest deferral): the Codex execution sandbox / approvals policy
 * (`sandbox_mode` / `approval_policy`). Codex honors a project-local `.codex/config.toml`
 * ONLY when the project is marked trusted in the GLOBAL `$CODEX_HOME/config.toml`
 * (`projects.<path>.trust_level`). Forge cannot grant that global trust during
 * project-local setup, so a rendered project-local sandbox policy would not take
 * effect. It is deferred to global-scope wiring and marked `not-delivered` in the
 * capability matrix (kernel epic 90f2f631 / #311).
 *
 * Defaults follow the principle: ALLOW the routine forge/dev workflow, DENY the
 * obviously-dangerous, and let everything else fall through to the harness's normal
 * "ask" behavior (Claude evaluates deny -> ask -> allow; unmatched tools still prompt).
 * We intentionally do NOT set `defaultMode`, so nothing is silently auto-approved.
 *
 * Dependency-free beyond node builtins so it runs under `bun test` and release gates.
 *
 * @module safety-config-renderer
 */

const fs = require('node:fs');
const path = require('node:path');

const { backupFile } = require('./mcp-config-renderer');

/** Thrown when an existing settings file cannot be parsed — signals "do not overwrite". */
class SafetyConfigParseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SafetyConfigParseError';
    this.cause = cause;
  }
}

// Safe Claude Code permission defaults. Rule syntax per Claude Code settings docs
// (https://docs.claude.com/en/docs/claude-code/settings ,
//  https://docs.claude.com/en/docs/claude-code/permissions):
//   Bash(<prefix>:*)  — command-prefix match; Read(<glob>) — gitignore-style path.
// Evaluated deny -> ask -> allow (deny always wins), so the deny Read(...) rules
// protect secrets even though bare Read is not blanket-allowed.
const CLAUDE_PERMISSION_DEFAULTS = Object.freeze({
  // Routine, reversible forge/dev workflow — safe to run without a prompt.
  allow: Object.freeze([
    'Bash(git status:*)',
    'Bash(git log:*)',
    'Bash(git diff:*)',
    'Bash(git branch:*)',
    'Bash(git show:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(git stash:*)',
    'Bash(git checkout:*)',
    'Bash(git switch:*)',
    'Bash(git pull:*)',
    'Bash(git fetch:*)',
    'Bash(git push:*)',
    'Bash(ls:*)',
    'Bash(cat:*)',
    'Bash(pwd)',
    'Bash(which:*)',
    'Bash(mkdir:*)',
    'Bash(cp:*)',
    'Bash(mv:*)',
    'Bash(bun run:*)',
    'Bash(bun test:*)',
    'Bash(bun install)',
    'Bash(npm run:*)',
    'Bash(npm test:*)',
    'Bash(forge:*)',
    'Bash(gh pr view:*)',
    'Bash(gh pr list:*)',
    'Bash(gh issue list:*)',
  ]),
  // Careful, rewrites-history / rewinds-state — worth a confirmation, not a hard block.
  ask: Object.freeze([
    'Bash(git rebase:*)',
    'Bash(git reset:*)',
    'Bash(git clean:*)',
  ]),
  // Obviously-dangerous commands + secret reads. deny wins over allow/ask.
  deny: Object.freeze([
    'Bash(rm -rf:*)',
    'Bash(rm -fr:*)',
    'Bash(git push --force:*)',
    'Bash(git push -f:*)',
    'Bash(git reset --hard:*)',
    // Read/secret boundary — private keys and secret env files are never readable.
    'Read(./.env)',
    'Read(**/.env)',
    'Read(**/.env.local)',
    'Read(**/.env.*.local)',
    'Read(**/*.pem)',
    'Read(**/*.key)',
    'Read(**/id_rsa)',
    'Read(**/id_ed25519)',
    'Read(./secrets/**)',
    'Read(**/credentials.json)',
  ]),
});

// Safe `.cursorignore` defaults (gitignore-style, per
// https://cursor.com/docs/reference/ignore-file). Cursor already ignores .gitignore
// and common lock/.env files by default; listing them here makes the secret/large-dir
// boundary explicit and self-documenting. `.cursorignore` blocks Cursor AI features +
// indexing (it is not a hard security boundary — terminal/MCP tools can still reach files).
const CURSORIGNORE_DEFAULTS = Object.freeze([
  '.env',
  '.env.local',
  '.env.*.local',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  'secrets/',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '*.log',
]);

const CURSORIGNORE_HEADER = [
  '# ---- Forge safe defaults (managed) ----',
  '# Keeps secrets and large/generated dirs out of Cursor AI context + index.',
  '# Edit freely — Forge only appends missing lines and never removes yours.',
];

function unionPreserve(existing, defaults) {
  const base = Array.isArray(existing) ? existing.filter(v => typeof v === 'string') : [];
  const seen = new Set(base);
  for (const rule of defaults) {
    if (!seen.has(rule)) {
      base.push(rule);
      seen.add(rule);
    }
  }
  return base;
}

/**
 * Merge safe permission defaults into an existing `.claude/settings.json` string
 * (read -> merge -> write). Preserves every other settings key and every existing
 * allow/deny/ask entry (union, no duplicates). Idempotent.
 * @param {string} existingText
 * @returns {string} pretty JSON with a trailing newline
 */
function mergeClaudePermissions(existingText) {
  let obj = {};
  if (existingText && existingText.trim()) {
    try {
      obj = JSON.parse(existingText);
    } catch (err) {
      // DATA-LOSS GUARD: never silently discard a populated-but-unparseable settings
      // file (e.g. JSONC with comments). Signal the caller to back up and skip.
      throw new SafetyConfigParseError('existing .claude/settings.json is not valid JSON', err);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  const existingPerms = (obj.permissions && typeof obj.permissions === 'object' && !Array.isArray(obj.permissions))
    ? obj.permissions
    : {};
  existingPerms.allow = unionPreserve(existingPerms.allow, CLAUDE_PERMISSION_DEFAULTS.allow);
  existingPerms.ask = unionPreserve(existingPerms.ask, CLAUDE_PERMISSION_DEFAULTS.ask);
  existingPerms.deny = unionPreserve(existingPerms.deny, CLAUDE_PERMISSION_DEFAULTS.deny);
  obj.permissions = existingPerms;
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Merge safe ignore defaults into an existing `.cursorignore` string (read -> merge
 * -> write). Preserves all user lines/comments verbatim and only appends default
 * patterns that are not already present. Idempotent.
 * @param {string} existingText
 * @returns {string}
 */
function mergeCursorIgnore(existingText) {
  const text = typeof existingText === 'string' ? existingText : '';
  const existingPatterns = new Set(
    text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')),
  );
  const missing = CURSORIGNORE_DEFAULTS.filter(pattern => !existingPatterns.has(pattern));
  const base = text.replace(/\s+$/, '');
  if (missing.length === 0) {
    return base ? `${base}\n` : '';
  }
  const lines = [];
  if (base) {
    lines.push(base, '');
  }
  // Only add the Forge header block if it isn't already present — otherwise a later
  // re-run (once CURSORIGNORE_DEFAULTS gains a new entry) would duplicate the header.
  if (!text.includes(CURSORIGNORE_HEADER[0])) {
    lines.push(...CURSORIGNORE_HEADER);
  }
  lines.push(...missing);
  return lines.join('\n') + '\n';
}

/**
 * Render safe Claude permission defaults into `.claude/settings.json`.
 * Read -> merge -> write. An unparseable existing file is BACKED UP and left
 * untouched (never overwritten) to avoid destroying user settings.
 * @param {object} params
 * @param {string} params.targetRoot - Project root.
 * @returns {{ file: string, existed: boolean, skipped: boolean, backup?: string }}
 */
function renderClaudePermissions({ targetRoot }) {
  const filePath = path.join(targetRoot, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existed = fs.existsSync(filePath);
  const existing = existed ? fs.readFileSync(filePath, 'utf-8') : '';

  let merged;
  try {
    merged = mergeClaudePermissions(existing);
  } catch (err) {
    if (err instanceof SafetyConfigParseError && existed) {
      const backup = backupFile(filePath);
      return { file: filePath, existed, skipped: true, backup };
    }
    throw err;
  }

  fs.writeFileSync(filePath, merged, 'utf-8');
  return { file: filePath, existed, skipped: false };
}

/**
 * Render safe `.cursorignore` defaults at the project root.
 * Read -> merge -> write, preserving user lines. Line-based, so there is no
 * parse-failure path (never destructive).
 * @param {object} params
 * @param {string} params.targetRoot - Project root.
 * @returns {{ file: string, existed: boolean, skipped: boolean }}
 */
function renderCursorIgnore({ targetRoot }) {
  const filePath = path.join(targetRoot, '.cursorignore');
  const existed = fs.existsSync(filePath);
  const existing = existed ? fs.readFileSync(filePath, 'utf-8') : '';
  const merged = mergeCursorIgnore(existing);
  fs.writeFileSync(filePath, merged, 'utf-8');
  return { file: filePath, existed, skipped: false };
}

module.exports = {
  SafetyConfigParseError,
  CLAUDE_PERMISSION_DEFAULTS,
  CURSORIGNORE_DEFAULTS,
  mergeClaudePermissions,
  mergeCursorIgnore,
  renderClaudePermissions,
  renderCursorIgnore,
};
