#!/usr/bin/env node
// Forge Dashboard — snapshot generator (read-only, v2).
//
// Shells the Forge CLI + git + gh and bakes a rich snapshot into:
//   snapshot.js  — a browser global (index.html opens by double-click, no server)
//   data.json    — the same payload, machine-readable (used by Refresh over HTTP)
//
// Sections: issues (+epic/parent links), decisions (kernel + ADR + headline),
// architecture docs, work-folder plans/history, and live ops (worktrees + PRs).
//
// Usage:  node web/dashboard/generate-snapshot.mjs
// Run from anywhere inside the repo/worktree; it locates bin/forge.js by walking up.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'bin', 'forge.js'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  throw new Error('Could not locate bin/forge.js above ' + start);
}

const ROOT = findRepoRoot(HERE);
const FORGE = join(ROOT, 'bin', 'forge.js');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}
function forge(args) { return JSON.parse(run(process.execPath, [FORGE, ...args])); }
function tryRun(fn, fallback, label) {
  try { return fn(); }
  catch (err) { console.warn(`  ! ${label} failed: ${String(err.message).split('\n')[0]}`); return fallback; }
}

const firstHeading = (md) => {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
};
const titleFromSlug = (slug) =>
  slug.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

console.log('Forge dashboard snapshot (v2)');
console.log('  repo:', ROOT);

// ---- issues ---------------------------------------------------------------
const listRes = forge(['issue', 'list', '--json']);
const issues = (listRes?.data?.issues ?? []).filter((i) => i && i.type !== 'zzzbogus');
console.log(`  issues: ${issues.length}`);
const statusRes = tryRun(() => forge(['status', '--json']), null, 'forge status');
const memory = tryRun(() => {
  const r = forge(['recall', '--json']);
  return Array.isArray(r) ? r : r?.data ?? [];
}, [], 'forge recall');

// ---- decisions: kernel issues + headline PDs + real ADRs -------------------
const decisions = [];
issues.filter((i) => i.type === 'decision').forEach((d) => {
  const body = (d.body || '').replace(/\r/g, '');
  decisions.push({
    id: d.id, title: d.title, status: d.status || 'open',
    rationale: body.replace(/^#+.*$/gm, '').replace(/\n{2,}/g, '\n').trim().slice(0, 600),
    component: (d.labels || [])[0] || null, source: 'kernel',
    updated_at: d.updated_at,
  });
});

// forge prime → "## Headline Decisions" block of PD-* records
tryRun(() => {
  const prime = run(process.execPath, [FORGE, 'prime']);
  const section = prime.split(/^##\s+Headline Decisions\s*$/m)[1];
  if (!section) return;
  const block = section.split(/^##\s+/m)[0];
  const chunks = block.split(/^- (?=PD-)/m).slice(1);
  chunks.forEach((c) => {
    const id = (c.split('\n')[0] || '').trim();
    const topic = (c.match(/topic:\s*(.+)/) || [])[1]?.trim() || null;
    const status = (c.match(/status:\s*(.+)/) || [])[1]?.trim() || 'accepted';
    const decision = (c.match(/decision:\s*([\s\S]+?)(?:\n\s*- PD-|\n*$)/) || [])[1]?.trim() || '';
    if (id) decisions.push({ id, title: topic || id, status, rationale: decision.slice(0, 600), component: topic, source: 'headline' });
  });
}, null, 'forge prime headline decisions');

// docs/adr/*.md (excluding README) — real ADRs when they exist
const adrDir = join(ROOT, 'docs', 'adr');
if (existsSync(adrDir)) {
  readdirSync(adrDir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').forEach((f) => {
    const md = readFileSync(join(adrDir, f), 'utf8');
    decisions.push({
      id: f.replace(/\.md$/, ''), title: firstHeading(md) || f,
      status: (md.match(/\*\*Status\*\*:\s*(.+)/i) || [])[1]?.trim() || 'proposed',
      rationale: (md.split(/^##\s+Decision/mi)[1] || md).replace(/^#+.*$/gm, '').trim().slice(0, 600),
      component: null, source: 'adr',
    });
  });
}
console.log(`  decisions: ${decisions.length}`);

// ---- architecture docs ----------------------------------------------------
const architecture = [];
const archDir = join(ROOT, 'docs', 'architecture');
const walkMd = (dir, rel = '') => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name); const r = rel ? `${rel}/${name}` : name;
    const st = statSync(p);
    if (st.isDirectory()) walkMd(p, r);
    else if (name.endsWith('.md')) {
      const md = readFileSync(p, 'utf8');
      architecture.push({ path: `docs/architecture/${r}`, title: firstHeading(md) || r, bytes: st.size });
    }
  }
};
walkMd(archDir);
console.log(`  architecture docs: ${architecture.length}`);

// ---- plans / history (work folders) ---------------------------------------
const plans = [];
const workDir = join(ROOT, 'docs', 'work');
if (existsSync(workDir)) {
  for (const slug of readdirSync(workDir)) {
    if (slug.startsWith('_')) continue;
    const dir = join(workDir, slug);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const design = files.includes('plan.md') ? 'plan.md' : files.find((f) => f !== 'README.md') || files[0];
    let title = titleFromSlug(slug);
    if (design) { const h = firstHeading(readFileSync(join(dir, design), 'utf8')); if (h) title = h; }
    const dateMatch = slug.match(/^(\d{4}-\d{2}-\d{2})/);
    plans.push({
      slug, title, date: dateMatch ? dateMatch[1] : null,
      hasPlan: files.includes('plan.md'), hasTasks: files.includes('tasks.md'),
      hasDecisions: files.includes('decisions.md'), docCount: files.length,
      path: `docs/work/${slug}${design ? '/' + design : ''}`,
    });
  }
  plans.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
console.log(`  plans: ${plans.length}`);

// ---- live ops: worktrees + PRs --------------------------------------------
const worktrees = tryRun(() => {
  const out = run('git', ['worktree', 'list', '--porcelain']);
  const trees = [];
  let cur = {};
  out.split('\n').forEach((line) => {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim() }; }
    else if (line.startsWith('HEAD ')) { cur.head = line.slice(5, 12); }
    else if (line.startsWith('branch ')) { cur.branch = line.slice(7).replace('refs/heads/', '').trim(); }
    else if (line.trim() === '' && cur.path) { trees.push(cur); cur = {}; }
  });
  if (cur.path) trees.push(cur);
  // Best-effort harness/surface inference from the worktree path. The REAL
  // harness/region tag will come from the kernel session record (see seam note).
  const inferSurface = (p) => {
    const s = String(p).replace(/\\/g, '/');
    if (/\.claude\/worktrees\/agent-/.test(s)) return 'claude-code';
    if (/[/]\.t3[/]/.test(s)) return 't3code';
    if (/temp|scratchpad|appdata\/local\/temp/i.test(s)) return 'ephemeral';
    if (/\.worktrees\//.test(s)) return 'worktree';
    return 'main';
  };
  trees.forEach((t) => { t.surface = inferSurface(t.path); });
  return trees;
}, [], 'git worktree list');

const prs = tryRun(() => {
  const out = run('gh', ['pr', 'list', '--json', 'number,title,state,headRefName,isDraft,reviewDecision,createdAt', '--limit', '30']);
  return JSON.parse(out);
}, [], 'gh pr list');

const activeClaims = issues
  .filter((i) => i.claimed_by && i.status === 'open')
  .map((i) => ({ id: i.id, title: i.title, owner: i.claimed_by, priority: i.priority, updated_at: i.updated_at }));

console.log(`  ops: ${worktrees.length} worktrees, ${prs.length} PRs, ${activeClaims.length} active claims`);

// ---- assemble + write -----------------------------------------------------
const snapshot = {
  generated_at: new Date().toISOString(),
  schema_version: listRes?.schema_version ?? null,
  source: 'forge issue list/status/recall/prime + git worktree + gh pr list',
  counts: {
    issues: issues.length, decisions: decisions.length,
    architecture: architecture.length, plans: plans.length,
    worktrees: worktrees.length, prs: prs.length,
    actors: [...new Set(activeClaims.map((c) => c.owner))].length,
  },
  // SEAM: session_id / worktree_id / harness / region live in the kernel lease
  // table (lib/kernel/lease-enforcer.js) but are not yet exposed by the CLI read
  // surface — only `claimed_by` (actor) is. The sync-rail / Phase-2 read API will
  // surface full leases; until then Live Ops renders actor + worktree + PRs and
  // infers `surface` from the worktree path.
  liveSeam: {
    exposed: ['claimed_by (actor)', 'git worktree list', 'gh pr list'],
    pending: ['session_id', 'worktree_id', 'harness', 'region', 'lease expires_at'],
  },
  status: statusRes,
  memory,
  issues,
  decisions,
  architecture,
  plans,
  ops: { worktrees, prs, activeClaims },
};

const json = JSON.stringify(snapshot);
writeFileSync(join(HERE, 'data.json'), JSON.stringify(snapshot, null, 2));
writeFileSync(
  join(HERE, 'snapshot.js'),
  `/* AUTO-GENERATED by generate-snapshot.mjs — do not edit by hand. */\n` +
    `window.FORGE_SNAPSHOT = ${json};\n`,
);

console.log('  wrote: web/dashboard/snapshot.js + data.json');
console.log(`  done @ ${snapshot.generated_at}`);
