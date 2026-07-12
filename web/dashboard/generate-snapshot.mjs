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

// ---- plans / history (work folders) + baked markdown for the in-render reader
const plans = [];
// docs: { "<slug>/<file>.md": "<raw markdown>" } → window.FORGE_DOCS. Bounded so
// the baked global stays reasonable: per-file cap + a total budget; oversize files
// are truncated with a marker rather than dropped silently.
const docs = {};
const DOC_FILE_CAP = 60 * 1024;      // 60 KB per file
const DOC_TOTAL_CAP = 4 * 1024 * 1024; // 4 MB total
let docBytes = 0;
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
    // Bake each markdown file (plan.md first for a stable default tab).
    const ordered = files.slice().sort((a, b) => (a === 'plan.md' ? -1 : b === 'plan.md' ? 1 : a.localeCompare(b)));
    for (const f of ordered) {
      if (docBytes >= DOC_TOTAL_CAP) break;
      let md = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
      if (md.length > DOC_FILE_CAP) md = md.slice(0, DOC_FILE_CAP) + '\n\n---\n\n_[truncated — file exceeds the ' + Math.round(DOC_FILE_CAP / 1024) + 'KB snapshot cap; open the file directly for the full text]_';
      docs[`${slug}/${f}`] = md;
      docBytes += md.length;
    }
  }
  plans.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
console.log(`  plans: ${plans.length} · baked docs: ${Object.keys(docs).length} (${Math.round(docBytes / 1024)} KB)`);

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
  // Best-effort harness inference from the worktree path. ALL harnesses are PEERS —
  // none is the default or the "real" one. Unknown → a neutral local surface, never
  // assumed to be any specific agent. The real harness + region tag (for ANY agent)
  // arrives from the kernel lease-read (7dc229d4). Path checks are OS-neutral
  // (backslashes normalized, case-insensitive).
  const inferSurface = (p) => {
    const s = String(p).replace(/\\/g, '/').toLowerCase();
    if (/\.claude\/worktrees\//.test(s)) return 'claude-code';
    if (/\.codex\/worktrees\/|\/\.codex\//.test(s)) return 'codex';
    if (/\.cursor\/worktrees\/|\/\.cursor\//.test(s)) return 'cursor';
    if (/\/\.t3\//.test(s)) return 't3code';
    if (/temp|scratchpad|appdata\/local\/temp/.test(s)) return 'cloud';
    if (/\.worktrees\//.test(s)) return 'worktree';
    return 'main';
  };
  trees.forEach((t) => {
    t.surface = inferSurface(t.path);
    // Real git state per worktree (ahead/behind vs origin/master + dirty count).
    try {
      const lr = run('git', ['-C', t.path, 'rev-list', '--left-right', '--count', 'origin/master...HEAD']).trim().split(/\s+/);
      t.behind = parseInt(lr[0], 10) || 0; t.ahead = parseInt(lr[1], 10) || 0;
    } catch { t.behind = null; t.ahead = null; }
    try {
      t.dirty = run('git', ['-C', t.path, 'status', '--porcelain']).split('\n').filter(Boolean).length;
    } catch { t.dirty = null; }
  });
  return trees;
}, [], 'git worktree list');

const ciOf = (rollup) => {
  let ok = 0, fail = 0, pend = 0, skip = 0;
  (rollup || []).forEach((c) => {
    const con = (c.conclusion || '').toUpperCase(), st = (c.state || c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(con) || st === 'FAILURE') fail++;
    else if (con === 'SUCCESS' || st === 'SUCCESS') ok++;
    else if (['SKIPPED', 'NEUTRAL'].includes(con)) skip++;
    else pend++;
  });
  return { ok, fail, pend, skip, state: fail ? 'fail' : pend ? 'pending' : 'pass' };
};

const prs = tryRun(() => {
  const out = run('gh', ['pr', 'list', '--json', 'number,title,state,headRefName,isDraft,reviewDecision,mergeable,statusCheckRollup,updatedAt,url', '--limit', '30']);
  return JSON.parse(out).map((p) => {
    const ci = ciOf(p.statusCheckRollup);
    const mins = Math.round((Date.now() - new Date(p.updatedAt)) / 60000);
    return {
      number: p.number, title: p.title, headRefName: p.headRefName, isDraft: p.isDraft,
      mergeable: p.mergeable, reviewDecision: p.reviewDecision, url: p.url, updatedAt: p.updatedAt,
      ci, minutesSince: mins,
      ready: p.mergeable === 'MERGEABLE' && ci.state === 'pass' && !p.isDraft && mins >= 10,
    };
  });
}, [], 'gh pr list');

const mergedPrs = tryRun(() => JSON.parse(run('gh', ['pr', 'list', '--state', 'merged', '--json', 'number,headRefName,mergedAt', '--limit', '60'])), [], 'gh pr list merged');
const openByBranch = {}; prs.forEach((p) => { openByBranch[p.headRefName] = p; });
const mergedByBranch = {}; mergedPrs.forEach((p) => { mergedByBranch[p.headRefName] = p; });

// SEAM: unresolved review-thread counts need a GraphQL query (not on `gh pr view --json`).
const prThreads = tryRun(() => {
  const q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}}}}}';
  const res = {};
  prs.forEach((p) => {
    try {
      const out = run('gh', ['api', 'graphql', '-f', `query=${q}`, '-F', 'o=harshanandak', '-F', 'r=forge', '-F', `n=${p.number}`]);
      const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
      res[p.number] = nodes.filter((t) => !t.isResolved).length;
    } catch { /* leave unset for this PR */ }
  });
  return Object.keys(res).length ? res : null;
}, null, 'gh graphql reviewThreads');

// link each worktree → its open/merged PR + archived state
worktrees.forEach((w) => {
  const op = openByBranch[w.branch], mp = mergedByBranch[w.branch];
  w.pr = op ? { number: op.number, ci: op.ci.state, ready: op.ready, mergeable: op.mergeable } : null;
  w.mergedPr = mp ? mp.number : null;
  w.archived = !op && !!mp;
});

// ---- real workflow stage (f61601ab) ---------------------------------------
// `forge issue list` omits current_stage, so read it per-issue with `forge show`
// for the bounded open+claimed set — the only issues whose phase previously fell
// back to the status+claim guess. Attaches current_stage/current_stage_status onto
// the issue record so the client renders the REAL stage (unknown fallback stays
// only while a claimed issue has no stage_run yet).
const claimedOpen = issues.filter((i) => i.claimed_by && i.status === 'open');
let stagePopulated = 0;
claimedOpen.forEach((i) => {
  const shown = tryRun(() => forge(['show', i.id, '--json']), null, `forge show ${String(i.id).slice(0, 8)}`);
  const d = shown?.data;
  if (d) {
    i.current_stage = d.current_stage ?? null;
    i.current_stage_status = d.current_stage_status ?? null;
    if (i.current_stage) stagePopulated++;
  }
});

// ---- live leases (7dc229d4 · forge claims) --------------------------------
// Authoritative active-lease feed replaces inferring liveness from issue.claimed_by.
// actor + claimed_at are real today; session_id / worktree_id / expires_at arrive
// null until the kernel writes them (liveness-by-expiry lights up automatically).
const PRANK = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
const leaseRes = tryRun(() => forge(['claims', '--json']), null, 'forge claims');
const leaseList = Array.isArray(leaseRes?.data?.claims) ? leaseRes.data.claims : null;
const nowMs = Date.now();
const leaseLiveness = (lease) => {
  if (!lease.expires_at) return 'active'; // no expiry known yet (kernel not writing it)
  return Date.parse(lease.expires_at) > nowMs ? 'live' : 'expired';
};
let activeClaims;
if (leaseList) {
  // One lease per issue (latest claimed_at wins if the single-active invariant ever
  // breaks); keep only leases whose issue exists and is open — the "what's running" set.
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const leaseByIssue = new Map();
  for (const l of leaseList) {
    const prev = leaseByIssue.get(l.issue_id);
    if (!prev || Date.parse(l.claimed_at || 0) > Date.parse(prev.claimed_at || 0)) leaseByIssue.set(l.issue_id, l);
  }
  activeClaims = [...leaseByIssue.values()]
    .map((l) => ({ l, issue: issueById.get(l.issue_id) }))
    .filter(({ issue }) => issue && issue.status === 'open')
    .map(({ l, issue }) => ({
      id: issue.id, title: issue.title, owner: l.actor, priority: issue.priority, updated_at: issue.updated_at,
      claimed_at: l.claimed_at ?? null, session_id: l.session_id ?? null,
      worktree_id: l.worktree_id ?? null, expires_at: l.expires_at ?? null,
      liveness: leaseLiveness(l),
    }))
    .sort((a, b) => (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9));
} else {
  // Fallback for a kernel without `forge claims`: infer from issue.claimed_by.
  activeClaims = claimedOpen.map((i) => ({
    id: i.id, title: i.title, owner: i.claimed_by, priority: i.priority, updated_at: i.updated_at,
    claimed_at: null, session_id: null, worktree_id: null, expires_at: null, liveness: 'active',
  }));
}
const staleLeaseCount = activeClaims.filter((c) => c.liveness === 'expired').length;
const leaseSourced = !!leaseList;

// ---- Needs Attention (control surface, ranked) ----------------------------
const needsAttention = [];
prs.forEach((p) => {
  if (p.isDraft) return;
  if (p.ready) needsAttention.push({ rank: 1, kind: 'ready', subject: `PR #${p.number}`, detail: p.title, why: `green + mergeable · ${p.minutesSince}m clean`, glyph: 'ready', link: p.url });
  else if (p.ci.state === 'fail') needsAttention.push({ rank: 2, kind: 'ci-fail', subject: `PR #${p.number}`, detail: p.title, why: `CI failing (${p.ci.fail} check${p.ci.fail > 1 ? 's' : ''})`, glyph: 'fail', link: p.url });
  else if (p.mergeable === 'CONFLICTING') needsAttention.push({ rank: 3, kind: 'conflict', subject: `PR #${p.number}`, detail: p.title, why: 'merge conflict — needs rebase', glyph: 'fail', link: p.url });
  if (prThreads && prThreads[p.number] > 0) needsAttention.push({ rank: 4, kind: 'threads', subject: `PR #${p.number}`, detail: p.title, why: `${prThreads[p.number]} unresolved review thread(s)`, glyph: 'open', link: p.url });
});
needsAttention.sort((a, b) => a.rank - b.rank);

console.log(`  ops: ${worktrees.length} worktrees, ${prs.length} open PRs, ${mergedPrs.length} merged, ${activeClaims.length} active claims (${leaseSourced ? 'forge claims' : 'inferred'})`);
console.log(`  stage_runs: ${stagePopulated}/${claimedOpen.length} claimed issues have a real current_stage · stale leases: ${staleLeaseCount}`);
console.log(`  needs-attention: ${needsAttention.length}`);

// ---- assemble + write -----------------------------------------------------
const snapshot = {
  generated_at: new Date().toISOString(),
  schema_version: listRes?.schema_version ?? null,
  source: 'forge issue list/status/recall/prime + git worktree + gh pr list/merged + gh graphql',
  counts: {
    issues: issues.length, decisions: decisions.length,
    architecture: architecture.length, plans: plans.length,
    worktrees: worktrees.length, prs: prs.length,
    actors: [...new Set(activeClaims.map((c) => c.owner))].length,
    needsAttention: needsAttention.length,
  },
  liveSeam: {
    exposed: ['active leases via forge claims (actor, claimed_at)', 'current_stage via forge show (stage_runs)', 'git worktree list (+ahead/behind/dirty)', 'gh pr list (+CI/mergeable)'],
    pending: ['lease session_id', 'lease worktree_id', 'harness', 'region', 'lease expires_at'],
  },
  // Real-vs-pending flags for the consumer wiring (5bfd2414).
  live: {
    leaseSourced,                 // activeClaims came from `forge claims` (authoritative) vs inferred
    stagePopulated,               // # claimed issues with a real current_stage today
    claimedOpen: claimedOpen.length,
    staleLeaseCount,              // leases past expires_at (0 until the kernel writes expires_at)
    expiryKnown: activeClaims.some((c) => c.expires_at),
    worktreeIdKnown: activeClaims.some((c) => c.worktree_id),
    sessionKnown: activeClaims.some((c) => c.session_id),
  },
  // Data seams — filed kernel issues that will replace best-effort/SEAM rendering.
  seams: {
    staleClaims: '7dc229d4 · lease-read expiry/heartbeat (forge claims exposes leases; expires_at null until the kernel writes it)',
    workflowStage: 'a2279f65 · current_stage now read from stage_runs (f61601ab); unknown only until a stage_run is recorded',
    workFolderGraph: '56461780 · work-folder ↔ PR/issue/decision connection graph',
    graphiti: 'c7971150 · Graphiti temporal-memory render feed (memory.backend=graphiti, opt-in)',
    backlogState: 'b2f856b1 · kernel backlog lifecycle state (parked ideas)',
    reviewThreads: prThreads ? null : 'GraphQL reviewThreads unavailable in this snapshot',
    harnessRegion: '7dc229d4 · real harness + region tag (surface below is inferred from path)',
  },
  needsAttention,
  backlog: null, // SEAM: kernel backlog state (b2f856b1) not yet landed
  status: statusRes,
  memory,
  issues,
  decisions,
  architecture,
  plans,
  ops: { worktrees, prs, mergedPrs, prThreads, activeClaims },
};

const json = JSON.stringify(snapshot);
writeFileSync(join(HERE, 'data.json'), JSON.stringify(snapshot, null, 2));
writeFileSync(
  join(HERE, 'snapshot.js'),
  `/* AUTO-GENERATED by generate-snapshot.mjs — do not edit by hand. */\n` +
    `window.FORGE_SNAPSHOT = ${json};\n`,
);
// Separate global so the (large) work-folder markdown does not bloat the kernel
// snapshot; both load as globals so index.html still opens by double-click (file://).
const docsJson = JSON.stringify(docs);
writeFileSync(
  join(HERE, 'docs.js'),
  `/* AUTO-GENERATED by generate-snapshot.mjs — do not edit by hand. */\n` +
    `window.FORGE_DOCS = ${docsJson};\n`,
);
// Plain-JSON twin of docs.js so an in-page Refresh (over HTTP) can reload the baked
// markdown alongside data.json — without it, edited/new work-folder docs stay stale
// until a full page reload. (file:// still bootstraps from docs.js.)
writeFileSync(join(HERE, 'docs.json'), docsJson);

console.log('  wrote: web/dashboard/snapshot.js + data.json + docs.js + docs.json');
console.log(`  done @ ${snapshot.generated_at}`);
