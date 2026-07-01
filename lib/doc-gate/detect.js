'use strict';

/**
 * doc-gate repo-structure detector.
 *
 * Ported (logic-for-logic) from the empirically-validated HYBRID detector v4.
 * v4 was tested to ZERO "silent-wrong" (a high-confidence answer that is
 * actually wrong) across 9 local repos AND 8 diverse OSS repos
 * (Python/Go/Rust/JS).
 *
 * Design (do not regress):
 *  - Tracked-files-only: every EXISTENCE and CONTENT signal comes from
 *    `git ls-tree HEAD` / `git ls-files` (never the raw filesystem), so
 *    untracked clutter and gitignored worktree/node_modules lockfiles/manifests
 *    can't poison detection.
 *  - Per-field results for source/toolchain/ci/changelog/agents, each
 *    `{ value, source: 'code'|'ABSTAIN→agent', confidence: 'high'|'medium'|'abstain', escalate? }`.
 *  - Abstain-by-default on the error-prone fields; emit HIGH only where
 *    deterministic. `codeHighConfidence` lists the silent-wrong-eligible fields.
 *  - Escalation triggers: monorepo (npm/pnpm/turbo workspaces, Cargo
 *    `[workspace]`, `go.work`), nested gitlink wrapper (escalate ALL fields),
 *    multiple conflicting lockfiles, and secondary non-conventional source roots.
 *  - SOURCE is language/manifest-first with a packaging/private-dir BLOCKLIST so
 *    it never returns internal/pkg/vendor/etc as THE source (the fix that
 *    eliminated the two real-world silent-wrongs: Go `internal/`, Rust `pkg/`).
 *
 * @module doc-gate/detect
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { loadDeclaration } = require('./declaration');

const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const readJSON = p => { try { return JSON.parse(read(p)); } catch { return null; } };
// NOSONAR S4036 - 'git' is a hardcoded CLI command with no user input; developer-tool context.
const git = (root, args) => { try { return cp.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } }; // NOSONAR S4036
const gitLines = (root, args) => git(root, args).split('\n').map(s => s.trim()).filter(Boolean);
const trackedTop = root => new Set(gitLines(root, ['ls-tree', 'HEAD', '--name-only']));
// Top-level TRACKED directories only (git object type `tree`), so file entries
// like go.mod / README.md are never mistaken for source directories.
const trackedTopDirs = root => new Set(
  git(root, ['ls-tree', 'HEAD']).split('\n').filter(Boolean)
    .filter(line => line.split(/\s+/)[1] === 'tree')
    .map(line => line.split('\t').pop())
    .filter(Boolean),
);
const trackedMatch = (root, patterns) => gitLines(root, ['ls-files', ...patterns]);
// Content reads are tracked-files-only too: only read a manifest if it is a
// tracked top-level file, so untracked worktree clutter can't change the verdict.
const readTracked = (root, top, name) => (top.has(name) ? read(path.join(root, name)) : '');
const readTrackedJSON = (root, top, name) => (top.has(name) ? readJSON(path.join(root, name)) : null);
const ABSTAIN = trigger => ({ value: null, source: 'ABSTAIN→agent', confidence: 'abstain', escalate: true, trigger });

// Dirs that are NEVER, on their own, the gate-worthy source (Linguist-style).
const BLOCKLIST = new Set(['internal', 'pkg', 'vendor', 'testdata', 'examples', 'example', 'tests', 'test', 'docs', 'doc', 'dist', 'build', 'target', 'node_modules', 'scripts', 'tools', 'bench', 'benches', '.github', 'assets', 'public', 'static']);

function detectNesting(root) {
  const lines = git(root, ['ls-tree', 'HEAD']).split('\n').filter(Boolean);
  if (!lines.length) return { nested: false };
  const gitlinks = lines.filter(l => l.startsWith('160000'));
  if (gitlinks.length >= 1 && lines.length - gitlinks.length <= 1) return { nested: true, nestedDir: gitlinks[0].split('\t').pop() };
  return { nested: false };
}

function detectMonorepo(root, top, topDirs) {
  const reasons = [];
  const pkg = readTrackedJSON(root, top, 'package.json');
  if (pkg?.workspaces) reasons.push('npm-workspaces');
  if (top.has('pnpm-workspace.yaml')) reasons.push('pnpm-workspace');
  if (top.has('turbo.json')) reasons.push('turbo');
  if (top.has('go.work')) reasons.push('go.work');
  const cargo = readTracked(root, top, 'Cargo.toml');
  if (/^\s*\[workspace\]/m.test(cargo) && /members\s*=/.test(cargo)) reasons.push('cargo-workspace');
  if (['apps', 'packages', 'services'].filter(d => topDirs.has(d)).length >= 2) reasons.push('apps+packages');
  return { monorepo: reasons.length > 0, reasons };
}

// --- language-specific source resolvers (kept small; detectSource dispatches) ---
// All directory candidates come from topDirs (tracked tree entries) so a tracked
// FILE named src/lib/<pkg> is never mistaken for a source directory.
function sourceRust(topDirs) {
  if (topDirs.has('src')) return { value: ['src'], source: 'code', confidence: 'high', lang: 'rust' };
  return ABSTAIN('rust-no-src');
}
function sourceGo(root, topDirs, has) {
  const rootGo = trackedMatch(root, ['*.go']).some(f => !f.includes('/')); // tracked .go at repo root
  if (rootGo) return { value: ['.'], source: 'code', confidence: 'high', lang: 'go', note: 'flat-root Go module' };
  const goDirs = [...topDirs].filter(d => has(d)); // DIRECTORIES only — never a top-level file like go.mod
  if (goDirs.length) return { value: goDirs, source: 'code', confidence: 'medium', lang: 'go' };
  return ABSTAIN('go-no-root-source');
}
function sourcePython(root, top, topDirs) {
  const py = readTracked(root, top, 'pyproject.toml');
  const nameMatch = py.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  const pkgName = nameMatch ? nameMatch[1].replaceAll('-', '_') : null;
  if (topDirs.has('src')) return { value: ['src'], source: 'code', confidence: 'high', lang: 'python' };
  if (pkgName && topDirs.has(pkgName)) return { value: [pkgName], source: 'code', confidence: 'high', lang: 'python', note: 'flat-layout package' };
  return ABSTAIN('python-package-dir-unresolved');
}
function sourceJs(root, top, conv, secondaryRoots) {
  if (secondaryRoots.length) return { ...ABSTAIN('secondary-roots:' + secondaryRoots.join('+')), conventionalSeen: conv };
  if (conv.length >= 1 && conv.length <= 2) return { value: conv, source: 'code', confidence: 'high', lang: 'js' };
  const pkg = readTrackedJSON(root, top, 'package.json') || {};
  // Only count a manifest entry that is an ACTUAL ROOT-LEVEL tracked file — a
  // nested entry like main:"dist/index.js" must NOT resolve source to '.'.
  const rootEntry = ['index.js', 'index.ts', 'index.mjs', pkg.main, pkg.module]
    .filter(Boolean)
    .map(f => String(f).replace(/^\.\//, ''))
    .some(f => !f.includes('/') && top.has(f));
  if (rootEntry) return { value: ['.'], source: 'code', confidence: 'medium', lang: 'js', note: 'root-entry single-file lib' };
  return ABSTAIN('js-no-conventional-source');
}

// Language-aware, manifest-first, blocklist-filtered source resolution.
function detectSource(root, top, topDirs, nested, mono) {
  if (nested) return ABSTAIN('nested');
  if (mono.monorepo) return ABSTAIN('monorepo:' + mono.reasons.join('+'));
  const has = d => topDirs.has(d) && !BLOCKLIST.has(d);
  const conv = ['src', 'lib', 'app'].filter(has);
  const secondaryRoots = ['convex', 'supabase', 'backend', 'frontend', 'server', 'functions', 'api', 'worker', 'workers', 'edge'].filter(d => topDirs.has(d));

  if (top.has('Cargo.toml')) return sourceRust(topDirs);
  if (top.has('go.mod')) return sourceGo(root, topDirs, has);
  if (readTracked(root, top, 'pyproject.toml') || top.has('setup.py')) return sourcePython(root, top, topDirs);
  if (top.has('package.json')) return sourceJs(root, top, conv, secondaryRoots);
  // Unknown stack.
  if (secondaryRoots.length) return ABSTAIN('secondary-roots:' + secondaryRoots.join('+'));
  if (conv.length >= 1 && conv.length <= 2) return { value: conv, source: 'code', confidence: 'high' };
  return ABSTAIN(conv.length ? 'ambiguous' : 'no-conventional-source-dir');
}

const LOCK = { 'bun.lockb': 'bun', 'bun.lock': 'bun', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'package-lock.json': 'npm', 'uv.lock': 'uv', 'poetry.lock': 'poetry', 'Pipfile.lock': 'pipenv', 'Cargo.lock': 'cargo', 'go.sum': 'go', 'composer.lock': 'composer' };
function detectToolchain(root, top, nested) {
  if (nested) return ABSTAIN('nested');
  const hits = trackedMatch(root, Object.keys(LOCK).map(f => '*' + f));
  const locks = hits.map(h => ({ file: h, manager: LOCK[h.split('/').pop()] })).filter(l => l.manager);
  const managers = [...new Set(locks.map(l => l.manager))];
  if (managers.length === 1) return { value: managers[0], source: 'code', confidence: 'high', lockfiles: locks.map(l => l.file) };
  if (managers.length > 1) return { ...ABSTAIN('multiple-lockfiles'), conflicting: locks };
  // No lockfile: fall back to manifest + non-lockfile pins.
  if (top.has('Cargo.toml')) return { value: 'cargo', source: 'code', confidence: 'high', note: 'Cargo.toml (lib omits Cargo.lock)' };
  if (top.has('go.mod')) return { value: 'go', source: 'code', confidence: 'high', note: 'go.mod' };
  const pj = readTrackedJSON(root, top, 'package.json');
  if (pj?.packageManager) return { value: String(pj.packageManager).split('@')[0], source: 'code', confidence: 'high', note: 'packageManager field' };
  return { value: null, source: 'code', confidence: 'abstain', escalateOrManual: true, note: 'no lockfile/manifest toolchain signal' };
}

const AGENT_SURFACES = [['.claude', 'claude'], ['.codex', 'codex'], ['.cursor', 'cursor'], ['.cline', 'cline'], ['.roo', 'roo'], ['.kilocode', 'kilocode'], ['.opencode', 'opencode'], ['.windsurf', 'windsurf'], ['AGENTS.md', 'agents-md'], ['CLAUDE.md', 'claude'], ['GEMINI.md', 'gemini'], ['.cursorrules', 'cursor'], ['.clinerules', 'cline'], ['.github/copilot-instructions.md', 'copilot']];
function detectAgents(root, top, nested) {
  const found = new Set();
  for (const [surface, name] of AGENT_SURFACES) {
    if (surface.includes('/') || surface.endsWith('.md')) { if (trackedMatch(root, [surface]).length) found.add(name); }
    else if (top.has(surface)) found.add(name);
  }
  const list = [...found];
  if (nested) return { value: list, source: 'ABSTAIN→agent', confidence: 'abstain', escalate: true, trigger: 'nested' };
  return { value: list, source: 'code', confidence: 'medium', note: 'tracked agent-surface enumeration (non-exhaustive)' };
}

const CL_BASES = ['changelog', 'changes', 'history', 'news', 'releases'];
// Case-insensitive top-level changelog file lookup (CHANGELOG/CHANGES/HISTORY/…, .md/.rst/.txt).
function changelogByBaseName(root, top) {
  const topLower = new Map([...top].map(e => [e.toLowerCase(), e]));
  for (const base of CL_BASES) {
    for (const ext of ['.md', '.rst', '.txt', '']) {
      const actual = topLower.get(base + ext);
      if (!actual) continue;
      const body = read(path.join(root, actual));
      const keep = /keep a changelog/i.test(body) || /##\s*\[?unreleased\]?/i.test(body);
      return { value: actual, format: keep ? 'keep-a-changelog' : 'structured-or-freeform', source: 'code', confidence: keep ? 'high' : 'medium' };
    }
  }
  return null;
}
function detectChangelog(root, top, nested) {
  if (nested) return ABSTAIN('nested');
  const byName = changelogByBaseName(root, top);
  if (byName) return byName;
  if (top.has('.changeset')) return { value: '.changeset', format: 'changesets', source: 'code', confidence: 'high' };
  const docsCl = trackedMatch(root, ['docs/**/release-notes.*', 'docs/**/changelog.*', 'docs/**/changes.*', 'docs/**/CHANGELOG.*']);
  if (docsCl.length) return { value: docsCl[0], format: 'docs-changelog', source: 'code', confidence: 'medium' };
  if (trackedMatch(root, ['.github/release-drafter.yml']).length) return { value: 'release-drafter', source: 'code', confidence: 'high' };
  if (top.has('.commitlintrc.json') || trackedMatch(root, ['.commitlintrc*', 'commitlint.config.*']).length) return { value: 'conventional-commits', source: 'code', confidence: 'medium' };
  return { value: null, source: 'code', confidence: 'abstain', escalateOrManual: true, note: 'no tracked changelog mechanism' };
}

function detectCI(root, top, nested) {
  if (nested) return ABSTAIN('nested');
  if (top.has('.github')) {
    const wf = trackedMatch(root, ['.github/workflows/*.yml', '.github/workflows/*.yaml']).map(f => f.split('/').pop());
    if (wf.length) return { provider: 'github-actions', workflows: wf, source: 'code', confidence: 'high' };
  }
  if (top.has('.gitlab-ci.yml')) return { provider: 'gitlab-ci', source: 'code', confidence: 'medium' };
  if (top.has('.circleci')) return { provider: 'circleci', source: 'code', confidence: 'medium' };
  return { provider: null, source: 'code', confidence: 'abstain', escalateOrManual: true, note: 'no tracked CI provider' };
}

/**
 * Apply a committed `.docgate.json` declaration on top of a detection result.
 *
 * "Declaration beats inference": a VALID declaration OVERRIDES the inferred
 * source (and, if declared, toolchain) and promotes the verdict to DECLARED —
 * but ONLY when it yields a concrete source surface (a declared `source`, or a
 * source detection already resolved). This is fail-closed: a DECLARED verdict is
 * enforced by the gate, so it must never rest on a null/empty surface. An
 * INVALID declaration never applies; its `errors` are attached as
 * `declarationErrors` so callers can surface them (the gate fails closed on them).
 *
 * @param {string} root - Repository root.
 * @param {object} result - The plain detection result to augment.
 * @returns {object} The (possibly) augmented result.
 */
function applyDeclaration(root, result) {
  const { declaration, errors } = loadDeclaration(root);
  if (errors.length > 0) return { ...result, declarationErrors: errors };
  if (!declaration) return result;

  const applied = { ...result, declaration };
  const overridden = new Set();
  if (Array.isArray(declaration.source) && declaration.source.length > 0) {
    applied.source = { value: [...declaration.source], source: 'declared', confidence: 'high' };
    overridden.add('source');
  }
  if (typeof declaration.toolchain === 'string' && declaration.toolchain) {
    applied.toolchain = { value: declaration.toolchain, source: 'declared', confidence: 'high' };
    overridden.add('toolchain');
  }

  // Promote to DECLARED only when an enforceable source surface exists.
  const surface = applied.source?.value;
  if (Array.isArray(surface) && surface.length > 0) {
    applied.declared = true;
    applied.verdict = 'DECLARED';
    applied.escalate = result.escalate.filter(e => !overridden.has(e.field));
  }
  return applied;
}

/**
 * Run the repo-structure detector against a git working tree.
 *
 * When a VALID `.docgate.json` is committed at the root it OVERRIDES inference:
 * the verdict becomes DECLARED (enforced by the gate exactly like CODE-RESOLVED)
 * and `declaration` is attached. An INVALID declaration attaches
 * `declarationErrors` and leaves normal detection untouched.
 *
 * @param {string} root - Absolute path to the repository root (a git working tree).
 * @returns {{ repo: string,
 *   verdict: 'ESCALATE-TO-AGENT'|'MANUAL-CONFIG'|'CODE-RESOLVED'|'DECLARED',
 *   nested: boolean, monorepo: object, escalate: Array, codeHighConfidence: string[],
 *   source: object, toolchain: object, agents: object, changelog: object, ci: object,
 *   declared?: boolean, declaration?: object, declarationErrors?: string[] }}
 */
function detect(root) {
  const top = trackedTop(root);
  const topDirs = trackedTopDirs(root);
  const nesting = detectNesting(root);
  const nested = nesting.nested;
  const mono = detectMonorepo(root, top, topDirs);
  const source = detectSource(root, top, topDirs, nested, mono);
  const toolchain = detectToolchain(root, top, nested);
  const agents = detectAgents(root, top, nested);
  const changelog = detectChangelog(root, top, nested);
  const ci = detectCI(root, top, nested);
  const fields = { source, toolchain, agents, changelog, ci };
  const escalate = [];
  if (nested) escalate.push({ field: 'whole-repo', trigger: 'nested-gitlink', detail: nesting.nestedDir });
  for (const [name, f] of Object.entries(fields)) if (f.escalate) escalate.push({ field: name, trigger: f.trigger });
  const codeHigh = Object.entries(fields).filter(([, f]) => f.source === 'code' && f.confidence === 'high').map(([n]) => n);
  // MANUAL-CONFIG when ANY field is a code-side abstain (changelog/ci/toolchain
  // with no signal) that wasn't escalated — a repo isn't fully CODE-RESOLVED
  // while, say, its toolchain is unresolved.
  const manualAbstain = Object.values(fields).some(f => f.source === 'code' && f.confidence === 'abstain');
  let verdict = 'CODE-RESOLVED';
  if (escalate.length > 0) verdict = 'ESCALATE-TO-AGENT';
  else if (manualAbstain) verdict = 'MANUAL-CONFIG';
  const result = { repo: path.basename(root), verdict, nested, monorepo: mono, escalate, codeHighConfidence: codeHigh, ...fields };
  return applyDeclaration(root, result);
}

module.exports = { detect, BLOCKLIST };
