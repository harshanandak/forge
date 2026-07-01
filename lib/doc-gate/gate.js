'use strict';

/**
 * doc-gate enforcement gate.
 *
 * Built ON TOP of the validated repo-structure detector
 * (lib/doc-gate/detect.js). The detector resolves a repo's source surface and
 * emits a `verdict` (CODE-RESOLVED | MANUAL-CONFIG | ESCALATE-TO-AGENT). This
 * module turns that surface into a PR gate that enforces the rule:
 *
 *   "a code change must be accompanied by a doc update."
 *
 * Design (do not regress):
 *  - ABSTAIN-first: if the detector could not confidently resolve the source
 *    surface (verdict MANUAL-CONFIG or ESCALATE-TO-AGENT) we NEVER hard-fail.
 *    This naturally exempts monorepos (e.g. forge itself, whose npm-workspaces
 *    layout escalates), so the gate is safe to make a required check.
 *  - Doc-path exclusion is mandatory: a flat-root `source:["."]` repo spans the
 *    whole tree (including docs), so doc-only edits must never be counted as a
 *    "code change".
 *  - Only Added/Modified files matter (the changelog-enforcer A/M pattern);
 *    deletions never require a doc update.
 *  - Dependency-free: Node built-ins + the tracked-git helper style from
 *    detect.js.
 *
 * @module doc-gate/gate
 */

const cp = require('node:child_process');
const { detect } = require('./detect');

// Strict git: THROWS on any failure. The gate must NEVER treat a git error (a bad
// ref, a diff failure) as "no changes" — that would fail the gate OPEN and defeat
// the "safe to require" design. Callers turn a throw into an explicit fail-closed.
function gitStrict(root, args) {
  const res = cp.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); // NOSONAR S4036 - hardcoded CLI command, no user input.
  if (res.error) throw new Error(`git ${args.join(' ')}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} exited ${res.status}: ${String(res.stderr || '').trim()}`);
  return res.stdout;
}

const toPosix = p => String(p).replaceAll('\\', '/').replace(/^\.\//, '');
const baseName = p => toPosix(p).split('/').pop();
const extOf = p => {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
};

// --- declaration glob matching (excludeFromGate / rules) ---------------------
// Deterministic, ReDoS-safe glob → RegExp. Only linear tokens are emitted
// (`[^/]*`, `[^/]`, `.*`, `(?:.*/)?`), anchored ^…$ — no nested/overlapping
// quantifiers, so committed (trusted) globs cannot cause catastrophic backtracking.
const GLOB_SPECIALS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
function globToRegExp(glob) {
  const g = toPosix(glob);
  let re = '^';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } // '**/' — zero or more dirs
      else { re += '.*'; i += 2; } // trailing '**' — anything, including '/'
    } else if (c === '*') {
      re += '[^/]*'; i += 1; // single-segment wildcard
    } else if (c === '?') {
      re += '[^/]'; i += 1;
    } else if (GLOB_SPECIALS.has(c)) {
      re += `\\${c}`; i += 1;
    } else {
      re += c; i += 1;
    }
  }
  return new RegExp(`${re}$`);
}

/**
 * True when repo-relative path `rel` matches ANY of `globs`. A bare directory
 * glob (no wildcard) also matches everything beneath it (prefix semantics).
 *
 * @param {string} rel - Repo-relative POSIX path.
 * @param {string[]} globs - Declaration globs.
 * @returns {boolean}
 */
function matchesAnyGlob(rel, globs) {
  for (const raw of globs) {
    const glob = toPosix(raw).replace(/\/+$/, '');
    if (!glob) continue;
    if (rel === glob || rel.startsWith(`${glob}/`)) return true; // exact or dir prefix
    if (globToRegExp(glob).test(rel)) return true;
  }
  return false;
}

// --- doc-path classification (mandatory exclusion) ---------------------------
const DOC_EXTS = new Set(['.md', '.mdx', '.rst']);
// Anchored so NEWSLETTER.js / LICENSEMANAGER.go (real code) are NOT treated as
// docs: the base name must be exactly the word, or word + a [._-] separator.
const DOC_BASENAME_RE = /^(README|CHANGELOG|HISTORY|NEWS|LICENSE)([._-].*)?$/i;
const DOC_DIR_PREFIXES = ['docs/', '.changeset/'];
const DOC_EXACT = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

/**
 * True when a repo-relative path is documentation (never counted as "code").
 * Covers markdown/rst family, README/CHANGELOG/HISTORY/NEWS/LICENSE files,
 * `docs/**`, `.changeset/**`, and the agent-instruction docs.
 *
 * @param {string} p - Repo-relative path (any OS separator).
 * @returns {boolean}
 */
function isDocPath(p) {
  const rel = toPosix(p);
  if (DOC_EXTS.has(extOf(rel))) return true;
  if (DOC_DIR_PREFIXES.some(d => rel.startsWith(d))) return true;
  const base = baseName(rel);
  if (DOC_EXACT.has(base)) return true;
  return DOC_BASENAME_RE.test(base);
}

// --- config classification (used only for a flat-root `.` source) ------------
const CONFIG_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lockb', 'bun.lock',
  'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', 'lerna.json',
  'tsconfig.json', 'jsconfig.json', 'go.mod', 'go.sum', 'go.work', 'go.work.sum',
  'cargo.toml', 'cargo.lock', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini',
  'requirements.txt', 'pipfile', 'pipfile.lock', 'poetry.lock', 'uv.lock',
  'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock', 'makefile', 'dockerfile',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.dockerignore',
  'lefthook.yml',
]);
const CONFIG_EXTS = new Set(['.yml', '.yaml', '.toml', '.ini', '.cfg', '.lock']);

/**
 * True when a path is project configuration rather than source. Applied only
 * when the source surface is the whole tree (`["."]`), so config edits in a
 * flat-root repo do not require a doc update.
 *
 * @param {string} p - Repo-relative path.
 * @returns {boolean}
 */
function isConfigPath(p) {
  const rel = toPosix(p);
  // Dotfiles / dot-directories (.github, .circleci, .vscode, .config, ...) are config.
  if (rel.split('/')[0].startsWith('.')) return true;
  if (CONFIG_BASENAMES.has(baseName(rel).toLowerCase())) return true;
  return CONFIG_EXTS.has(extOf(rel));
}

// --- change parsing ----------------------------------------------------------
/**
 * Normalise a git status letter (or word) to ADDED / MODIFIED / DELETED.
 * @param {string} s
 * @returns {'ADDED'|'MODIFIED'|'DELETED'}
 */
function normalizeStatus(s) {
  const v = String(s || 'M').toUpperCase();
  if (v.startsWith('A')) return 'ADDED';
  if (v.startsWith('D')) return 'DELETED';
  return 'MODIFIED';
}

/**
 * Parse `git diff --name-status` output into `{ status, path }` records.
 * Renames/copies (R###/C###) resolve to the NEW path, classified as ADDED.
 *
 * @param {string} out - Raw name-status output.
 * @returns {Array<{status:string, path:string}>}
 */
function parseNameStatus(out) {
  const changes = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const letter = parts[0][0];
    if (letter === 'R' || letter === 'C') {
      changes.push({ status: 'ADDED', path: parts[parts.length - 1] });
    } else if (parts[1]) {
      changes.push({ status: normalizeStatus(letter), path: parts[1] });
    }
  }
  return changes;
}

/**
 * Normalise caller-supplied `changedFiles` (strings or `{status,path}` objects)
 * into `{ status, path }` records. Bare strings default to MODIFIED.
 *
 * @param {Array<string|{status?:string, path:string}>} changedFiles
 * @returns {Array<{status:string, path:string}>}
 */
function normalizeChangedFiles(changedFiles) {
  const out = [];
  for (const entry of changedFiles) {
    if (typeof entry === 'string') {
      out.push({ status: 'MODIFIED', path: entry });
    } else if (entry?.path) {
      out.push({ status: normalizeStatus(entry.status), path: entry.path });
    }
  }
  return out;
}

/**
 * From the Added/Modified changes, return the ones that count as CODE under the
 * resolved source surface. Docs are always excluded; paths matching a declared
 * `excludeFromGate` glob are excluded; for a flat-root `["."]` surface only
 * top-level, non-config files count.
 *
 * @param {Array<{status:string, path:string}>} changes
 * @param {string[]|null} sourceDirs
 * @param {string[]} [excludeGlobs] - Declared `excludeFromGate` globs.
 * @returns {string[]} repo-relative code paths
 */
function codeChangesUnderSource(changes, sourceDirs, excludeGlobs = []) {
  const dirs = Array.isArray(sourceDirs) ? sourceDirs.map(p => toPosix(p)) : [];
  const flatRoot = dirs.includes('.');
  const code = [];
  for (const change of changes) {
    if (change.status === 'DELETED') continue;
    const rel = toPosix(change.path);
    if (isDocPath(rel)) continue;
    if (excludeGlobs.length > 0 && matchesAnyGlob(rel, excludeGlobs)) continue; // declared exclusion
    if (flatRoot) {
      if (!rel.includes('/') && !isConfigPath(rel)) code.push(rel);
      continue;
    }
    if (dirs.some(d => rel === d || rel.startsWith(`${d}/`))) code.push(rel);
  }
  return code;
}

/**
 * Apply declared `rules`: a changed non-doc file matching `rule.when` REQUIRES
 * the `rule.requires` path to be Added/Modified in the same change set. Returns
 * a precise message for each violated rule (empty when all satisfied).
 *
 * @param {Array<{status:string, path:string}>} changes
 * @param {Array<{when:string, requires:string}>} rules
 * @returns {string[]} violation messages
 */
function checkDeclaredRules(changes, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const touched = changes.filter(c => c.status !== 'DELETED').map(c => toPosix(c.path));
  const violations = [];
  for (const rule of rules) {
    const triggered = touched.filter(p => !isDocPath(p) && matchesAnyGlob(p, [rule.when]));
    if (triggered.length === 0) continue;
    const requires = toPosix(rule.requires);
    const satisfied = touched.some(p => p === requires || matchesAnyGlob(p, [rule.requires]));
    if (!satisfied) {
      violations.push(`change to ${triggered[0]} requires an update to "${rule.requires}" (rule when="${rule.when}")`);
    }
  }
  return violations;
}

/**
 * Resolve the changed-file set: caller-supplied `changedFiles` when present,
 * otherwise the tracked `git diff --name-status <base>...<head>` (three-dot, PR
 * semantics).
 *
 * @param {{root:string, base?:string, head?:string, changedFiles?:Array}} opts
 * @returns {Array<{status:string, path:string}>}
 */
function resolveChanges({ root, base, head, changedFiles }) {
  if (Array.isArray(changedFiles)) return normalizeChangedFiles(changedFiles);
  if (!base || !head) return [];
  // Validate BOTH refs resolve to a commit before diffing — a bad ref throws
  // (fail-closed) rather than yielding an empty, gate-passing diff.
  gitStrict(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  gitStrict(root, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  return parseNameStatus(gitStrict(root, ['diff', '--name-status', `${base}...${head}`]));
}

/**
 * Evaluate the doc-gate for a pull request.
 *
 * @param {Object} opts
 * @param {string} opts.root - Absolute repo root (a git working tree).
 * @param {string} [opts.base] - Base ref/SHA (required unless `changedFiles`).
 * @param {string} [opts.head] - Head ref/SHA (required unless `changedFiles`).
 * @param {Array<string|{status?:string, path:string}>} [opts.changedFiles] -
 *   Pre-computed change set; bypasses `git diff`.
 * @param {boolean} [opts.skip] - Force a pass (e.g. a `no-docs-needed` label).
 * @returns {{ decision:'pass'|'fail'|'abstain', reason:string,
 *   offendingCodeFiles:string[], docChangesSeen:string[],
 *   sourceSurface:(string[]|null), verdict:string }}
 */
function evaluateGate({ root, base, head, changedFiles, skip } = {}) {
  const result = detect(root);
  const sourceSurface = result.source ? result.source.value : null;
  const verdict = result.verdict;
  const summary = { sourceSurface, verdict };

  // FAIL-CLOSED on an INVALID committed `.docgate.json`: a malformed declaration
  // is a config error that must block a required check, never silently pass —
  // checked BEFORE `skip` so a broken declaration can't be waved through.
  if (Array.isArray(result.declarationErrors) && result.declarationErrors.length > 0) {
    return {
      decision: 'fail',
      reason: `invalid .docgate.json declaration: ${result.declarationErrors.join('; ')}`,
      offendingCodeFiles: [],
      docChangesSeen: [],
      ...summary,
    };
  }

  if (skip) {
    return { decision: 'pass', reason: 'skipped', offendingCodeFiles: [], docChangesSeen: [], ...summary };
  }

  if (verdict === 'ESCALATE-TO-AGENT' || verdict === 'MANUAL-CONFIG') {
    return {
      decision: 'abstain',
      reason: `detector verdict ${verdict}: source surface not confidently resolved; not enforcing`,
      offendingCodeFiles: [],
      docChangesSeen: [],
      ...summary,
    };
  }

  // CODE-RESOLVED or DECLARED (a committed declaration is enforced exactly like
  // CODE-RESOLVED): the source surface is a concrete set of dirs (or ".").
  let changes;
  try {
    changes = resolveChanges({ root, base, head, changedFiles });
  } catch (err) {
    // FAIL-CLOSED: a git error (bad refs / diff failure) must not silently pass a
    // required check — surface it as a failure so the PR is investigated.
    return {
      decision: 'fail',
      reason: `could not compute the PR diff (${err.message}); failing closed`,
      offendingCodeFiles: [],
      docChangesSeen: [],
      ...summary,
    };
  }
  const excludeGlobs = result.declaration?.excludeFromGate ?? [];
  const docChangesSeen = changes
    .filter(c => c.status !== 'DELETED' && isDocPath(c.path))
    .map(c => toPosix(c.path));
  const offending = codeChangesUnderSource(changes, sourceSurface, excludeGlobs);

  if (offending.length > 0 && docChangesSeen.length === 0) {
    return {
      decision: 'fail',
      reason: `${offending.length} code change(s) under source surface [${(sourceSurface || []).join(', ')}] with no accompanying doc update`,
      offendingCodeFiles: offending,
      docChangesSeen,
      ...summary,
    };
  }

  // Declared `rules` are enforced independently of the doc-companion check: a
  // triggered rule fails even when a doc update accompanied the code change.
  const ruleViolations = checkDeclaredRules(changes, result.declaration?.rules ?? []);
  if (ruleViolations.length > 0) {
    return {
      decision: 'fail',
      reason: ruleViolations.join('; '),
      offendingCodeFiles: offending,
      docChangesSeen,
      ...summary,
    };
  }

  const reason = offending.length === 0
    ? 'no code change under the source surface'
    : 'code change accompanied by a doc update';
  return { decision: 'pass', reason, offendingCodeFiles: [], docChangesSeen, ...summary };
}

module.exports = { evaluateGate, isDocPath, isConfigPath, parseNameStatus };
