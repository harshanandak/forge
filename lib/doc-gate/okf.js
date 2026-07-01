'use strict';

/**
 * doc-gate OKF (Open Knowledge Format) bundle generator.
 *
 * Deterministic, script-first "markdown -> OKF bundle" core. A "bundle" is a
 * directory tree of concept docs (the unit of distribution). Each source `.md`
 * becomes a concept doc whose Concept ID is its path minus `.md`.
 *
 * Spec facts implemented (OKF v0.1 DRAFT — "not an official Google product"):
 *  - Concept front matter: the ONLY required key is `type`. `title` is the
 *    optional display name (there is NO `name` key). We inject `type` + `title`
 *    and preserve the body verbatim.
 *  - Per-folder `index.md` lists that folder's contents and carries NO front
 *    matter. The BUNDLE-ROOT `index.md` is the ONLY index that may carry front
 *    matter, for exactly one key: `okf_version: "0.1"`.
 *
 * OKF is a SERIALIZATION / interop format only — it has no enforcement or query
 * semantics. Generation NEVER touches detect()/gate() verdicts; resolution
 * correctness stays doc-gate's own concern.
 *
 * Conventions shared with the rest of doc-gate:
 *  - Tracked-files-only reads: source markdown comes from `git ls-files`, never a
 *    raw filesystem walk, so untracked clutter can't leak into a bundle.
 *  - Fail-closed git wrapper that THROWS.
 *  - Symlink-safe writes: every write target is `lstat`-checked and refused if it
 *    (or a parent component) is a symlink, and nothing is ever written outside the
 *    out dir.
 *
 * @module doc-gate/okf
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const OKF_VERSION = '0.1';
const ROOT_INDEX = 'index.md';
const NAV_BEGIN = '<!-- BEGIN FORGE OKF NAV -->';
const NAV_END = '<!-- END FORGE OKF NAV -->';

// Top-level markdown that is boilerplate, not knowledge-base content. Only used
// by the auto-source fallback (when there is no docs/ dir and no --source).
const AGENT_OR_META_MD = new Set([
  'agents.md', 'claude.md', 'gemini.md', 'readme.md', 'contributing.md',
  'license.md', 'changelog.md', 'code_of_conduct.md', 'security.md',
]);

// --- git (fail-closed) --------------------------------------------------------

/** Strict git wrapper — THROWS on any failure (fail-closed), like declaration.js. */
function gitStrict(root, args) {
  // NOSONAR S4036 - hardcoded CLI command, no user input; developer-tool context.
  const res = cp.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); // NOSONAR S4036
  if (res.error) throw new Error(`git ${args.join(' ')}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${res.status}: ${String(res.stderr || '').trim()}`);
  }
  return res.stdout;
}

/** Tracked files (repo-relative, forward-slashed) at `root`. */
function trackedFiles(root) {
  return gitStrict(root, ['ls-files'])
    .split('\n')
    .map(s => s.trim())
    .filter(line => line !== '');
}

// --- path hygiene -------------------------------------------------------------

/**
 * Normalize + validate a user-supplied relative path. Rejects blank/whitespace
 * input and any `..` segment; returns a forward-slashed, trimmed path. A lone
 * `.` normalizes to '' (meaning "repo root").
 */
function cleanRel(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty path`);
  }
  const norm = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const stripped = norm === '.' ? '' : norm;
  if (stripped.split('/').some(seg => seg === '..')) {
    throw new Error(`${label} must not contain '..': ${value}`);
  }
  return stripped;
}

// --- source resolution --------------------------------------------------------

const isMarkdown = file => file.toLowerCase().endsWith('.md');

/** True when a fallback markdown file should be skipped (out dir / boilerplate). */
function isExcludedFallback(file, outRel) {
  if (outRel !== '' && (file === outRel || file.startsWith(`${outRel}/`))) return true;
  if (!file.includes('/') && AGENT_OR_META_MD.has(file.toLowerCase())) return true;
  return false;
}

/**
 * Resolve the source markdown set + the base dir concept paths are relative to.
 * With `--source`: tracked markdown UNDER that dir. Auto: prefer `docs/`; else
 * fall back to all tracked markdown minus the out dir and top-level boilerplate.
 */
function resolveSources(root, sourceRel, outRel) {
  const all = trackedFiles(root);
  if (sourceRel !== null) {
    const base = sourceRel;
    const prefix = base === '' ? '' : `${base}/`;
    const files = all.filter(f => isMarkdown(f) && f.startsWith(prefix) && f !== base);
    return { base, files };
  }
  const docs = all.filter(f => isMarkdown(f) && f.startsWith('docs/'));
  if (docs.length > 0) return { base: 'docs', files: docs };
  const files = all.filter(f => isMarkdown(f) && !isExcludedFallback(f, outRel));
  return { base: '', files };
}

/** Concept path relative to the source base dir. */
function conceptRel(file, base) {
  return base === '' ? file : file.slice(base.length + 1);
}

// --- concept construction -----------------------------------------------------

/** Infer a sensible OKF `type` from the concept path (default `document`). */
function inferType(rel) {
  const p = rel.toLowerCase();
  if (p.includes('guide') || p.includes('tutorial') || p.includes('how-to') || p.includes('howto')) {
    return 'guide';
  }
  if (p.includes('reference') || p.includes('/api/') || p.startsWith('api/')) {
    return 'reference';
  }
  return 'document';
}

/** First ATX H1 (`# Title`) in `body`, or null. */
function firstHeading(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/** Strip surrounding single/double quotes from a YAML scalar. */
function stripYamlScalar(value) {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Split a leading YAML front-matter block. Returns `{ inner, body }` where
 * `inner` is the raw block content (no `---` fences) or null when absent.
 */
function splitFrontMatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { inner: null, body: content };
  return { inner: m[1], body: content.slice(m[0].length) };
}

/** Set of top-level keys present in a raw front-matter block (lower-cased). */
function frontMatterKeys(inner) {
  const keys = new Set();
  for (const line of inner.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (m) keys.add(m[1].toLowerCase());
  }
  return keys;
}

/** Display title for a concept: H1, else existing front-matter title, else filename. */
function conceptTitle(content, rel) {
  const { inner, body } = splitFrontMatter(content);
  const heading = firstHeading(body);
  if (heading) return heading;
  if (inner) {
    const m = inner.match(/^title\s*:\s*(.+?)\s*$/m);
    if (m) return stripYamlScalar(m[1]);
  }
  return path.posix.basename(rel).replace(/\.md$/i, '');
}

/**
 * Build the concept doc content: ensure a single front-matter block that carries
 * at least `type` (+ `title`), preserving the original body and any pre-existing
 * front matter (only MISSING required keys are appended — never duplicated).
 */
function buildConcept(content, rel, title) {
  const { inner, body } = splitFrontMatter(content);
  if (inner === null) {
    const fm = `---\ntype: ${JSON.stringify(inferType(rel))}\ntitle: ${JSON.stringify(title)}\n---\n`;
    return `${fm}\n${content}`;
  }
  const keys = frontMatterKeys(inner);
  const additions = [];
  if (!keys.has('type')) additions.push(`type: ${JSON.stringify(inferType(rel))}`);
  if (!keys.has('title')) additions.push(`title: ${JSON.stringify(title)}`);
  const mergedInner = additions.length > 0 ? `${inner}\n${additions.join('\n')}` : inner;
  return `---\n${mergedInner}\n---\n${body}`;
}

// --- index construction -------------------------------------------------------

/** Build a folder tree: `Map<dir, { files: string[], subdirs: Set<string> }>`. */
function buildTree(conceptRels) {
  const folders = new Map();
  const ensure = dir => {
    if (!folders.has(dir)) folders.set(dir, { files: [], subdirs: new Set() });
    return folders.get(dir);
  };
  ensure('');
  for (const rel of conceptRels) {
    const dirName = path.posix.dirname(rel);
    const dir = dirName === '.' ? '' : dirName;
    ensure(dir).files.push(rel);
    let child = dir;
    while (child !== '') {
      const parentName = path.posix.dirname(child);
      const parent = parentName === '.' ? '' : parentName;
      ensure(parent).subdirs.add(child);
      child = parent;
    }
  }
  return folders;
}

const byLocale = (a, b) => a.localeCompare(b);

/**
 * Render a folder's `index.md`. The bundle-root index (dir === '') is the ONLY
 * one that carries front matter, for the single key `okf_version`.
 */
function renderIndex(dir, node, titles) {
  const isRoot = dir === '';
  const lines = [];
  if (isRoot) lines.push('---', `okf_version: ${JSON.stringify(OKF_VERSION)}`, '---', '');
  lines.push(`# ${isRoot ? 'Knowledge Base' : path.posix.basename(dir)}`, '');
  for (const sub of [...node.subdirs].sort(byLocale)) {
    const rel = path.posix.relative(dir, sub);
    lines.push(`- [${path.posix.basename(sub)}/](${rel}/index.md)`);
  }
  for (const file of [...node.files].sort(byLocale)) {
    const rel = path.posix.relative(dir, file);
    lines.push(`- [${titles.get(file)}](${rel})`);
  }
  return `${lines.join('\n')}\n`;
}

// --- symlink-safe writing -----------------------------------------------------

/** Prepare the out dir: refuse a symlink, create it if missing, require a dir. */
function prepareOutRoot(outAbs) {
  let stat = null;
  try { stat = fs.lstatSync(outAbs); } catch { /* absent: stat stays null */ }
  if (stat?.isSymbolicLink()) {
    throw new Error(`out dir is a symlink; refusing to write through it: ${outAbs}`);
  }
  if (stat === null) { fs.mkdirSync(outAbs, { recursive: true }); return; }
  if (!stat.isDirectory()) throw new Error(`out path exists and is not a directory: ${outAbs}`);
}

/** Create the dir chain under `outAbs`, refusing to traverse a symlinked component. */
function ensureDirSafe(outAbs, dirAbs) {
  const relParts = path.relative(outAbs, dirAbs).split(path.sep).filter(seg => seg !== '');
  let cur = outAbs;
  for (const part of relParts) {
    cur = path.join(cur, part);
    let stat = null;
    try { stat = fs.lstatSync(cur); } catch { /* absent: stat stays null */ }
    if (stat?.isSymbolicLink()) {
      throw new Error(`refusing to write through a symlinked directory: ${cur}`);
    }
    if (stat === null) fs.mkdirSync(cur);
  }
}

/** Write `content` to `outAbs/relPath`, symlink-safe and contained within `outAbs`. */
function writeFileSafe(outAbs, relPath, content) {
  const targetAbs = path.resolve(outAbs, relPath);
  const within = path.relative(outAbs, targetAbs);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`refusing to write outside the out dir: ${relPath}`);
  }
  ensureDirSafe(outAbs, path.dirname(targetAbs));
  let stat = null;
  try { stat = fs.lstatSync(targetAbs); } catch { /* absent: stat stays null */ }
  if (stat?.isSymbolicLink()) {
    throw new Error(`${relPath} is a symlink; refusing to write through it.`);
  }
  fs.writeFileSync(targetAbs, content);
}

// --- public API ---------------------------------------------------------------

/**
 * Generate an OKF bundle from a repo's tracked markdown.
 *
 * @param {object} opts
 * @param {string} opts.root - Repository root (a git working tree).
 * @param {string} [opts.source] - Source docs dir; auto-detected when omitted.
 * @param {string} [opts.out='.okf'] - Bundle output dir (must not be the repo root).
 * @returns {{ ok: boolean, error?: string, out?: string, source?: string,
 *   concepts?: string[], count?: number, okfVersion?: string }}
 */
function generateBundle({ root, source, out } = {}) {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('root must be a non-empty path');
  const outRel = cleanRel(out ?? '.okf', 'out');
  if (outRel === '') throw new Error('out dir must not be the repo root');
  const sourceRel = source === undefined || source === null ? null : cleanRel(source, 'source');

  const { base, files } = resolveSources(root, sourceRel, outRel);
  if (files.length === 0) {
    return { ok: false, error: 'No tracked markdown found to generate an OKF bundle from.' };
  }

  const outAbs = path.resolve(root, outRel);
  prepareOutRoot(outAbs);

  const concepts = [];
  const titles = new Map();
  for (const file of files) {
    const rel = conceptRel(file, base);
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const title = conceptTitle(content, rel);
    titles.set(rel, title);
    writeFileSafe(outAbs, rel, buildConcept(content, rel, title));
    concepts.push(rel);
  }

  for (const [dir, node] of buildTree(concepts)) {
    const indexRel = dir === '' ? ROOT_INDEX : `${dir}/${ROOT_INDEX}`;
    writeFileSafe(outAbs, indexRel, renderIndex(dir, node, titles));
  }

  return {
    ok: true,
    out: outRel,
    source: base === '' ? '(tracked markdown)' : base,
    concepts: concepts.sort(byLocale),
    count: concepts.length,
    okfVersion: OKF_VERSION,
  };
}

/** Build the delimited AGENTS.md managed nav block pointing at the bundle root. */
function buildNavBlock(outRel) {
  const indexRel = `${outRel}/${ROOT_INDEX}`;
  return [
    NAV_BEGIN,
    '## Knowledge Base (OKF)',
    '',
    'This repository maintains an Open Knowledge Format (OKF v0.1 draft) bundle.',
    `Start at the bundle index: [\`${indexRel}\`](${indexRel}).`,
    '',
    'This is a thin navigation overlay; the bundle itself is the source of truth.',
    NAV_END,
  ].join('\n');
}

/** Insert or replace the managed nav block, preserving surrounding content. */
function upsertNavBlock(existing, block) {
  const start = existing.indexOf(NAV_BEGIN);
  const end = existing.indexOf(NAV_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + NAV_END.length)}`;
  }
  if (existing === '') return `${block}\n`;
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${block}\n`;
}

/**
 * Write/update a thin OKF navigation section in AGENTS.md (NOT CLAUDE.md) that
 * POINTS AT the bundle root index. Idempotent via a delimited managed block.
 *
 * @param {object} opts
 * @param {string} opts.root - Repository root.
 * @param {string} [opts.out='.okf'] - Bundle dir the nav should point at.
 * @returns {{ ok: boolean, path: string, target: string, created: boolean }}
 */
function linkAgentsMd({ root, out } = {}) {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('root must be a non-empty path');
  const outRel = cleanRel(out ?? '.okf', 'out');
  if (outRel === '') throw new Error('out dir must not be the repo root');

  const agentsAbs = path.join(root, 'AGENTS.md');
  let stat = null;
  try { stat = fs.lstatSync(agentsAbs); } catch { /* absent: stat stays null */ }
  if (stat?.isSymbolicLink()) {
    throw new Error('AGENTS.md is a symlink; refusing to write through it.');
  }
  const existing = stat === null ? '' : fs.readFileSync(agentsAbs, 'utf8');
  fs.writeFileSync(agentsAbs, upsertNavBlock(existing, buildNavBlock(outRel)));
  return { ok: true, path: 'AGENTS.md', target: `${outRel}/${ROOT_INDEX}`, created: stat === null };
}

module.exports = { generateBundle, linkAgentsMd, OKF_VERSION };
