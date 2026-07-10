/* Forge Dashboard v2 — read-only multi-view app.
   Consumes a baked kernel snapshot (window.FORGE_SNAPSHOT). No framework, no build.
   Views: overview, board (task/epic kanban), epics, decisions, plans, ops. */

/* ============================================================================
 * DataSource — the LIVE-VIEW SEAM.
 * load()  : returns a snapshot. Baked global today; re-fetch over HTTP on refresh.
 * refresh(): re-reads data.json (cache-busted) so the manual/auto Refresh gets
 *            fresh data after the generator re-runs. When the sync rail lands,
 *            implement subscribe(onDelta) over the outbox feed (EventSource) and
 *            the views update with NO render changes.
 * ========================================================================== */
const DataSource = {
  async load() {
    if (window.FORGE_SNAPSHOT) return window.FORGE_SNAPSHOT;
    return (await fetch('data.json')).json();
  },
  async refetch() {
    // Works when served over HTTP (data.json present). Throws on file:// — caller
    // falls back to a full reload (which re-reads the regenerated snapshot.js).
    const res = await fetch('data.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  },
  subscribe() { /* TODO(sync-rail): new EventSource('/events') → onDelta(patch) */ },
};

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

const PRIO_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4'];
const PRIO_VAR = { P0: '--p0', P1: '--p1', P2: '--p2', P3: '--p3', P4: '--p4' };
const TYPE_LABEL = { feature: 'feat', task: 'task', bug: 'bug', epic: 'epic', decision: 'dec', chore: 'chore' };
const HEALTH = {
  ok: { label: 'On track', v: '--ok' }, warn: { label: 'At risk', v: '--warn' },
  risk: { label: 'Off track', v: '--risk' }, done: { label: 'Completed', v: '--ok' },
  neutral: { label: '—', v: '--neutral' },
};

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  const dd = Math.round(h / 24); if (dd < 30) return dd + 'd ago';
  return d.toISOString().slice(0, 10);
}

function icon(name) {
  const p = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    board: '<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="15" rx="1"/>',
    epics: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    decisions: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.5 6H14a2 2 0 0 1 2 2v2"/>',
    plans: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ops: '<path d="M3 12h4l2 6 4-14 2 8h6"/>',
    doc: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>',
    branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 8.5v7M18 8.5V11a3 3 0 0 1-3 3H6"/>',
  }[name] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

/* ---------- state ---------- */
const State = {
  snapshot: null, issues: [], epics: [], byId: {}, kids: {},
  filters: { q: '', type: null, prio: null },
  board: { level: 'tasks', epicFocus: null, limits: {} },
  epicsTab: 'active', epicsExpanded: new Set(),
  route: 'overview',
};

function rebuild(snap) {
  State.snapshot = snap;
  const issues = (snap.issues || []).filter((i) => i && i.type !== 'zzzbogus');
  State.issues = issues;
  State.byId = {}; State.kids = {};
  issues.forEach((i) => { State.byId[i.id] = i; if (i.parent_id) (State.kids[i.parent_id] = State.kids[i.parent_id] || []).push(i); });
  State.epics = issues.filter((i) => i.type === 'epic');
}

/* ---------- pure derivation (exported for tests) ---------- */
function columnOf(i) {
  if (i.status === 'done') return 'done';
  if (i.status === 'cancelled') return null;
  if (i.blocked) return 'blocked';
  if (i.claimed_by) return 'progress';
  return 'ready';
}
function matchesFilter(i) {
  const f = State.filters;
  if (f.type && i.type !== f.type) return false;
  if (f.prio && i.priority !== f.prio) return false;
  if (f.q) {
    const hay = (i.title + ' ' + i.id + ' ' + (i.claimed_by || '') + ' ' + (i.labels || []).join(' ')).toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}
function epicRollup(epic, kids) {
  kids = kids || State.kids[epic.id] || [];
  const total = kids.length;
  const done = kids.filter((k) => k.status === 'done').length;
  const blocked = kids.filter((k) => k.blocked && k.status === 'open').length;
  const inprog = kids.filter((k) => k.claimed_by && k.status === 'open' && !k.blocked).length;
  return { total, done, blocked, inprog, open: total - done, ratio: total ? done / total : 0 };
}
function epicHealth(epic, kids) {
  if (epic.status === 'done') return 'done';
  if (epic.status === 'cancelled') return 'neutral';
  const r = epicRollup(epic, kids);
  if (r.total === 0) return epic.blocked ? 'risk' : 'ok';
  if (r.blocked / r.total >= 0.25) return 'risk';
  if (r.ratio >= 0.5) return 'ok';
  if (r.ratio >= 0.2 || r.inprog > 0) return 'warn';
  return r.blocked > 0 ? 'risk' : 'warn';
}

/* ---------- shared bits ---------- */
const prioBadge = (p) => `<span class="badge badge--prio" style="background:var(${PRIO_VAR[p] || '--faint'})">${esc(p || '—')}</span>`;
const typeBadge = (t) => `<span class="badge badge--type">${esc(TYPE_LABEL[t] || t)}</span>`;
const epicRef = (i) => {
  if (!i.parent_id) return '';
  const e = State.byId[i.parent_id]; if (!e) return '';
  return `<span class="epicref"><span class="dot"></span>${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 26))}</span>`;
};
function taskCard(i) {
  const owner = i.claimed_by
    ? `<span class="kcard__owner"><span class="av">${esc(i.claimed_by.slice(0, 2))}</span>${esc(i.claimed_by)}</span>` : '';
  const deps = i.dependencies && i.dependencies.length ? `<span class="badge badge--soft">${i.dependencies.length} dep</span>` : '';
  return `<div class="kcard" style="--prio:var(${PRIO_VAR[i.priority] || '--border'})">
    <div class="kcard__top">${typeBadge(i.type)}${prioBadge(i.priority)}<span class="kcard__id">${esc(String(i.id).slice(0, 8))}</span></div>
    <div class="kcard__title">${esc(clamp(i.title, 120))}</div>
    <div class="kcard__meta">${owner}${epicRef(i)}${deps}</div>
  </div>`;
}
function epicCard(e) {
  const r = epicRollup(e); const h = HEALTH[epicHealth(e)];
  return `<div class="kcard kcard--epic" data-act="focus-epic" data-id="${esc(e.id)}" style="--prio:var(${h.v})">
    <div class="kcard__top"><span class="hdot" style="background:var(${h.v})"></span>${prioBadge(e.priority)}<span class="kcard__id">${r.total} tasks</span></div>
    <div class="kcard__title">${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 110))}</div>
    <div class="kcard__roll"><div class="kcard__prog"><span style="width:${Math.round(r.ratio * 100)}%"></span></div>
      <span class="kcard__rolltext">${r.done}/${r.total || '·'}</span></div>
  </div>`;
}

/* ============================================================================
 * VIEWS
 * ========================================================================== */
const VIEWS = [
  { id: 'overview', title: 'Overview', flush: false, render: renderOverview },
  { id: 'board', title: 'Work Board', flush: true, render: renderBoard },
  { id: 'epics', title: 'Epics', flush: false, render: renderEpics },
  { id: 'decisions', title: 'Decisions', flush: false, render: renderDecisions },
  { id: 'plans', title: 'Plans & History', flush: false, render: renderPlans },
  { id: 'ops', title: 'Live Ops', flush: false, render: renderOps },
];

/* ---- Overview ---- */
function renderOverview() {
  const all = State.issues;
  const st = (k) => all.filter((i) => i.status === k).length;
  const total = all.length, done = st('done'), open = st('open');
  const donePct = total ? Math.round((done / total) * 100) : 0;
  const blocked = all.filter((i) => i.blocked && i.status !== 'done').length;
  const active = all.filter((i) => i.claimed_by && i.status === 'open').length;
  const ready = all.filter((i) => columnOf(i) === 'ready').length;
  const c = State.snapshot.counts || {};

  const tiles = [
    { n: total, l: 'Total issues', s: State.snapshot.schema_version || '', v: '--accent' },
    { n: donePct + '%', l: 'Complete', s: done + ' done', v: '--ok' },
    { n: open, l: 'Open', s: ready + ' ready', v: '--st-ready' },
    { n: active, l: 'In progress', s: 'claimed now', v: '--st-progress' },
    { n: blocked, l: 'Blocked', s: 'need unblocking', v: '--st-blocked' },
    { n: State.epics.length, l: 'Epics', s: (c.decisions || 0) + ' decisions', v: '--accent' },
  ];

  const prio = {}; PRIO_ORDER.forEach((p) => (prio[p] = 0));
  all.forEach((i) => { if (prio[i.priority] != null) prio[i.priority]++; });
  const types = {}; all.forEach((i) => (types[i.type] = (types[i.type] || 0) + 1));

  const bar = PRIO_ORDER.map((p) => `<span title="${p}: ${prio[p]}" style="width:${(prio[p] / (total || 1)) * 100}%;background:var(${PRIO_VAR[p]})"></span>`).join('');
  const legend = PRIO_ORDER.map((p) => `<span class="item"><span class="sw" style="background:var(${PRIO_VAR[p]})"></span>${p} <b>${prio[p]}</b></span>`).join('');
  const chips = Object.entries(types).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="item"><span class="sw" style="background:var(--surface-3)"></span>${esc(TYPE_LABEL[t] || t)} <b>${n}</b></span>`).join('');

  const recent = all.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 8)
    .map((i) => `<div class="pr-row"><span class="hdot" style="background:var(${i.blocked ? '--st-blocked' : i.status === 'done' ? '--st-done' : '--st-ready'})"></span>
      <span class="pr-title">${esc(clamp(i.title, 70))}</span><span class="pr-branch">${esc(relTime(i.updated_at))}</span></div>`).join('');

  return `<div class="fade-in">
    <div class="stats">${tiles.map((t) => `<div class="stat" style="--accar:var(${t.v})"><div class="stat__num">${esc(t.n)}</div><div class="stat__label">${esc(t.l)}</div><div class="stat__sub">${esc(t.s)}</div></div>`).join('')}</div>
    <div class="overview-grid">
      <div class="panel"><h3>Priority distribution</h3><div class="bar">${bar}</div><div class="legend">${legend}</div></div>
      <div class="panel"><h3>Issue types</h3><div class="legend">${chips}</div></div>
    </div>
    <div class="overview-grid">
      <div class="panel" style="padding:0"><h3 style="padding:16px 16px 0">Recent activity</h3><div style="padding:6px 4px">${recent}</div></div>
      <div class="panel"><h3>Live ops</h3><div class="legend">
        <span class="item">Worktrees <b>${c.worktrees || 0}</b></span>
        <span class="item">Open PRs <b>${c.prs || 0}</b></span>
        <span class="item">Active claims <b>${(State.snapshot.ops && State.snapshot.ops.activeClaims.length) || 0}</b></span>
        <span class="item">Plans <b>${c.plans || 0}</b></span>
      </div><div style="margin-top:14px;color:var(--faint);font-size:12px">Jump into <a href="#/ops" style="color:var(--accent)">Live Ops →</a></div></div>
    </div>
  </div>`;
}

/* ---- Work Board (Kanban) ---- */
const TASK_COLS = [
  { key: 'ready', title: 'Ready', v: '--st-ready' },
  { key: 'progress', title: 'In progress', v: '--st-progress' },
  { key: 'blocked', title: 'Blocked', v: '--st-blocked' },
  { key: 'done', title: 'Done', v: '--st-done' },
];
const EPIC_COLS = [
  { key: 'ok', title: 'On track', v: '--ok' },
  { key: 'warn', title: 'At risk', v: '--warn' },
  { key: 'risk', title: 'Off track', v: '--risk' },
  { key: 'done', title: 'Completed', v: '--ok' },
];

function renderBoard() {
  const B = State.board;
  const focus = B.epicFocus ? State.byId[B.epicFocus] : null;
  const levelSeg = `<div class="seg">
    <button data-act="board-level" data-level="tasks" class="${B.level === 'tasks' ? 'on' : ''}">Tasks</button>
    <button data-act="board-level" data-level="epics" class="${B.level === 'epics' ? 'on' : ''}">Epics</button></div>`;
  const focusChip = focus ? `<span class="chipfilter">Epic: ${esc(clamp(focus.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 34))}<button data-act="clear-focus" title="Clear">✕</button></span>` : '';

  let chips = '';
  if (B.level === 'tasks') {
    const types = [...new Set(State.issues.map((i) => i.type))].filter((t) => t && t !== 'epic');
    chips = `<div class="controls">${types.map((t) => `<button class="btn" data-act="chip-type" data-val="${t}" style="${State.filters.type === t ? 'border-color:var(--accent);color:var(--accent)' : ''}">${esc(TYPE_LABEL[t] || t)}</button>`).join('')}
      ${PRIO_ORDER.map((p) => `<button class="btn" data-act="chip-prio" data-val="${p}" style="${State.filters.prio === p ? 'border-color:var(--accent);color:var(--accent)' : ''}">${p}</button>`).join('')}</div>`;
  }
  const miniSearch = `<div class="minisearch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="boardSearch" type="search" placeholder="Filter cards…" value="${esc(State.filters.q)}"></div>`;

  const cols = B.level === 'epics' ? renderEpicColumns() : renderTaskColumns(focus);
  return `<div class="boardbar">${levelSeg}${focusChip}${chips}${miniSearch}</div><div class="board">${cols}</div>`;
}

function column(col, cards, count, key) {
  const lim = State.board.limits[key] ?? 25;
  const shown = cards.slice(0, lim);
  const more = cards.length > lim
    ? `<button class="kmore" data-act="more" data-col="${key}">Show ${Math.min(25, cards.length - lim)} more · ${cards.length - lim} hidden</button>` : '';
  const body = shown.length ? shown.join('') + more : `<div class="kempty">Nothing here.</div>`;
  return `<div class="kcol"><div class="kcol__head"><span class="hdot" style="background:var(${col.v})"></span>
    <span class="kcol__title">${esc(col.title)}</span><span class="kcol__count">${count}</span></div>
    <div class="kcol__body">${body}</div></div>`;
}
function renderTaskColumns(focus) {
  let pool = State.issues.filter((i) => i.type !== 'epic' && matchesFilter(i));
  if (focus) pool = pool.filter((i) => i.parent_id === focus.id);
  const buckets = { ready: [], progress: [], blocked: [], done: [] };
  pool.forEach((i) => { const c = columnOf(i); if (c) buckets[c].push(i); });
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  ['ready', 'progress', 'blocked'].forEach((k) => buckets[k].sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || new Date(b.updated_at) - new Date(a.updated_at)));
  buckets.done.sort((a, b) => new Date(b.closed_at || b.updated_at) - new Date(a.closed_at || a.updated_at));
  return TASK_COLS.map((c) => column(c, buckets[c.key].map(taskCard), buckets[c.key].length, c.key)).join('');
}
function renderEpicColumns() {
  const buckets = { ok: [], warn: [], risk: [], done: [] };
  State.epics.filter((e) => !State.filters.q || (e.title.toLowerCase().includes(State.filters.q.toLowerCase())))
    .forEach((e) => { const h = epicHealth(e); const key = h === 'neutral' ? 'warn' : h; (buckets[key] || buckets.warn).push(e); });
  Object.keys(buckets).forEach((k) => buckets[k].sort((a, b) => epicRollup(b).total - epicRollup(a).total));
  return EPIC_COLS.map((c) => column(c, buckets[c.key].map(epicCard), buckets[c.key].length, 'e_' + c.key)).join('');
}

/* ---- Epics / Initiatives table ---- */
const EPIC_TABS = [
  { id: 'active', label: 'Active' }, { id: 'planned', label: 'Planned' },
  { id: 'completed', label: 'Completed' }, { id: 'all', label: 'All' },
];
function epicTabMatch(e) {
  const r = epicRollup(e);
  switch (State.epicsTab) {
    case 'completed': return e.status === 'done';
    case 'planned': return e.status === 'open' && r.total === 0 && !e.claimed_by;
    case 'active': return e.status === 'open' && (r.total > 0 || e.claimed_by || e.blocked);
    default: return true;
  }
}
function renderEpics() {
  const tabs = `<div class="tabs">${EPIC_TABS.map((t) => `<button data-act="epics-tab" data-tab="${t.id}" class="${State.epicsTab === t.id ? 'on' : ''}">${t.label}</button>`).join('')}</div>`;
  const eps = State.epics.filter(epicTabMatch)
    .sort((a, b) => epicRollup(b).total - epicRollup(a).total || new Date(b.updated_at) - new Date(a.updated_at));

  const rows = eps.map((e) => {
    const r = epicRollup(e); const h = HEALTH[epicHealth(e)];
    const kids = State.kids[e.id] || [];
    const open = State.epicsExpanded.has(e.id);
    const sub = (e.labels || [])[0] ? `<div class="sub">${esc(e.labels[0])}</div>` : '';
    const workdots = `<span class="workdots">${r.inprog ? `<span class="wd"><span class="dot" style="background:var(--st-progress)"></span>${r.inprog}</span>` : ''}${r.blocked ? `<span class="wd"><span class="dot" style="background:var(--st-blocked)"></span>${r.blocked}</span>` : ''}${!r.inprog && !r.blocked ? '<span class="wd">—</span>' : ''}</span>`;
    const parentRow = `<tr>
      <td><div class="rowname">
        <span class="chev ${kids.length ? (open ? 'open' : '') : 'leaf'}" data-act="toggle-epic" data-id="${esc(e.id)}">${kids.length ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="12" height="12"><path d="m9 6 6 6-6 6"/></svg>' : ''}</span>
        <span class="ic">${icon('epics')}</span>
        <span><span class="tt" data-act="focus-epic" data-id="${esc(e.id)}" style="cursor:pointer">${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 68))}</span>${sub}</span>
      </div></td>
      <td class="num" style="color:var(--faint)">—</td>
      <td><span class="health"><span class="hdot" style="background:var(${h.v})"></span>${h.label}</span></td>
      <td><div class="progresscell"><div class="mini"><span style="width:${Math.round(r.ratio * 100)}%;background:var(${h.v})"></span></div><span class="frac">${r.done}/${r.total || '·'}</span></div></td>
      <td>${workdots}</td>
      <td><span class="trend">${esc(relTime(e.updated_at))}</span></td></tr>`;
    let childRows = '';
    if (open) {
      childRows = kids.slice().sort((a, b) => (a.status === 'done') - (b.status === 'done')).map((k) => `<tr class="child">
        <td><div class="rowname"><span class="chev leaf"></span>${typeBadge(k.type)}<span class="tt">${esc(clamp(k.title, 62))}</span></div></td>
        <td></td>
        <td><span class="health"><span class="dot" style="background:var(${k.blocked ? '--st-blocked' : k.status === 'done' ? '--st-done' : k.claimed_by ? '--st-progress' : '--st-ready'})"></span>${esc(k.blocked ? 'blocked' : k.status)}</span></td>
        <td>${prioBadge(k.priority)}</td>
        <td>${k.claimed_by ? `<span class="kcard__owner"><span class="av">${esc(k.claimed_by.slice(0, 2))}</span></span>` : ''}</td>
        <td><span class="trend">${esc(relTime(k.updated_at))}</span></td></tr>`).join('');
    }
    return parentRow + childRows;
  }).join('');

  const body = eps.length ? `<div class="tblwrap"><table class="tbl">
    <thead><tr><th>Name</th><th>Target</th><th>Health</th><th>Progress</th><th>Active</th><th>Activity</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h4>No epics in this tab</h4><p>Try the “All” tab.</p></div>`;
  return `<div class="fade-in"><div class="viewhead">${tabs}<div class="topbar__spacer"></div><span class="crumb">${eps.length} initiatives · click a row title to open it in the board</span></div>${body}</div>`;
}

/* ---- Decisions + Architecture ---- */
function renderDecisions() {
  const decs = State.snapshot.decisions || [];
  const groups = [
    { key: 'kernel', label: 'Kernel decisions' },
    { key: 'headline', label: 'Architecture decisions (headline)' },
    { key: 'adr', label: 'ADRs' },
  ];
  const statusClass = (s) => { const l = (s || '').toLowerCase(); if (l.startsWith('accept')) return 'accepted'; if (l.startsWith('propos')) return 'proposed'; if (l.startsWith('supersed')) return 'superseded'; if (l.startsWith('deprecat')) return 'deprecated'; if (l === 'done') return 'done'; return 'open'; };
  const card = (d) => `<div class="deccard">
    <div class="deccard__top"><span class="stbadge ${statusClass(d.status)}">${esc(d.status || 'open')}</span>${d.component ? `<span class="badge badge--soft">${esc(clamp(d.component, 28))}</span>` : ''}</div>
    <div class="deccard__title">${esc(d.title)}</div>
    <div class="deccard__body">${esc(clamp(d.rationale || '', 320))}</div>
    <div class="deccard__foot"><span class="deccard__id">${esc(String(d.id))}</span></div></div>`;

  let html = '<div class="fade-in">';
  groups.forEach((g) => {
    const items = decs.filter((d) => d.source === g.key);
    if (!items.length) return;
    html += `<div class="section-title">${esc(g.label)} · ${items.length}</div><div class="deckgrid">${items.map(card).join('')}</div>`;
  });
  const arch = State.snapshot.architecture || [];
  html += `<div class="section-title">Architecture docs · ${arch.length}</div>`;
  html += arch.length ? `<div class="arch-list">${arch.map((a) => `<div class="arch-row"><span class="ic">${icon('doc')}</span><span>${esc(a.title)}</span><span class="p">${esc(a.path)}</span></div>`).join('')}</div>`
    : `<div class="empty-state"><h4>No architecture docs indexed</h4><p>Add records under docs/architecture/ or docs/adr/.</p></div>`;
  if (!decs.length) html += `<div class="empty-state"><h4>No decisions in this snapshot</h4><p>Kernel type=decision issues and headline PDs appear here.</p></div>`;
  return html + '</div>';
}

/* ---- Plans & History ---- */
function renderPlans() {
  const plans = (State.snapshot.plans || []).slice();
  const monthLabel = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Undated';
  const groups = {};
  plans.forEach((p) => { const m = p.date ? p.date.slice(0, 7) : 'zzzz'; (groups[m] = groups[m] || []).push(p); });
  const months = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const tag = (on, label) => on ? `<span class="badge badge--soft">${label}</span>` : '';
  let html = `<div class="fade-in"><div class="viewhead"><span class="crumb">${plans.length} work folders · newest first</span></div>`;
  months.forEach((m) => {
    html += `<div class="tl-month">${esc(groups[m][0].date ? monthLabel(groups[m][0].date) : 'Undated')}</div>`;
    groups[m].forEach((p) => {
      html += `<div class="tl-row">
        <span class="tl-date">${esc(p.date || '—')}</span>
        <div><div class="tl-title">${esc(clamp(p.title, 84))}</div><div class="tl-slug">${esc(p.slug)}</div></div>
        <div class="tl-tags">${tag(p.hasPlan, 'plan')}${tag(p.hasTasks, 'tasks')}${tag(p.hasDecisions, 'decisions')}<span class="badge badge--soft">${p.docCount} docs</span></div>
      </div>`;
    });
  });
  return html + '</div>';
}

/* ---- Live Ops ---- */
function renderOps() {
  const ops = State.snapshot.ops || { worktrees: [], prs: [], activeClaims: [] };
  const claims = ops.activeClaims || [];
  const claimsHtml = claims.length ? claims.map((c) => `<div class="pr-row"><span class="kcard__owner"><span class="av">${esc((c.owner || '?').slice(0, 2))}</span></span>
    <span class="pr-title">${esc(clamp(c.title, 56))}</span>${prioBadge(c.priority)}<span class="pr-branch">${esc(relTime(c.updated_at))}</span></div>`).join('')
    : `<div class="empty-state"><h4>No active claims</h4><p>Claimed-and-open issues appear here.</p></div>`;

  const prs = ops.prs || [];
  const prsHtml = prs.length ? prs.map((p) => `<div class="pr-row"><span class="pr-num">#${esc(p.number)}</span>
    <span class="pr-title">${esc(clamp(p.title, 60))}</span>${p.isDraft ? '<span class="badge badge--soft">draft</span>' : ''}
    <span class="stbadge ${p.state === 'OPEN' ? 'open' : 'done'}">${esc((p.state || '').toLowerCase())}</span></div>`).join('')
    : `<div class="empty-state"><h4>No open PRs</h4><p>gh pr list returned none (or gh is unavailable).</p></div>`;

  const trees = ops.worktrees || [];
  const treeRows = trees.map((w) => `<tr><td><div class="rowname"><span class="ic">${icon('branch')}</span><span class="tt">${esc(w.branch || '(detached)')}</span></div></td>
    <td class="num" style="color:var(--faint)">${esc(w.head || '')}</td><td><span class="mono-path">${esc(w.path)}</span></td></tr>`).join('');

  return `<div class="fade-in">
    <div class="ops-grid">
      <div class="panel" style="padding:0"><h3 style="padding:16px 16px 6px">Active work · ${claims.length}</h3><div>${claimsHtml}</div></div>
      <div class="panel" style="padding:0"><h3 style="padding:16px 16px 6px">Open pull requests · ${prs.length}</h3><div>${prsHtml}</div></div>
    </div>
    <div class="section-title">Git worktrees · ${trees.length}</div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Branch</th><th>HEAD</th><th>Path</th></tr></thead><tbody>${treeRows}</tbody></table></div>
  </div>`;
}

/* ============================================================================
 * Router + chrome
 * ========================================================================== */
function currentView() { return VIEWS.find((v) => v.id === State.route) || VIEWS[0]; }
function route() {
  const id = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  State.route = VIEWS.some((v) => v.id === id) ? id : 'overview';
  const v = currentView();
  $('#viewTitle').textContent = v.title;
  $('#viewCrumb').textContent = '';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v.id));
  const view = $('#view');
  view.classList.toggle('view--flush', !!v.flush);
  view.innerHTML = v.render();
  view.scrollTop = 0;
  afterRender();
}
function afterRender() {
  const bs = $('#boardSearch');
  if (bs) bs.addEventListener('input', (e) => { State.filters.q = e.target.value.trim(); rerender(); }, { once: false });
}
function rerender() { const v = currentView(); const view = $('#view'); const focus = document.activeElement?.id; view.innerHTML = v.render(); afterRender(); if (focus === 'boardSearch') { const el = $('#boardSearch'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } }

function buildNav() {
  const counts = { board: State.issues.filter((i) => i.type !== 'epic').length, epics: State.epics.length, decisions: (State.snapshot.decisions || []).length, plans: (State.snapshot.plans || []).length, ops: (State.snapshot.ops?.worktrees || []).length };
  $('#nav').innerHTML = `<div class="nav__label">Views</div>` + VIEWS.map((v) =>
    `<a href="#/${v.id}" data-view="${v.id}">${icon(v.id)}<span>${esc(v.title)}</span>${counts[v.id] != null ? `<span class="n">${counts[v.id]}</span>` : ''}</a>`).join('');
}

/* ---- delegated actions ---- */
function onViewClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (act === 'board-level') { State.board.level = t.dataset.level; State.board.limits = {}; rerender(); }
  else if (act === 'focus-epic') { State.board.epicFocus = t.dataset.id; State.board.level = 'tasks'; State.board.limits = {}; location.hash = '#/board'; }
  else if (act === 'clear-focus') { State.board.epicFocus = null; rerender(); }
  else if (act === 'more') { const k = t.dataset.col; State.board.limits[k] = (State.board.limits[k] ?? 25) + 25; rerender(); }
  else if (act === 'chip-type') { State.filters.type = State.filters.type === t.dataset.val ? null : t.dataset.val; rerender(); }
  else if (act === 'chip-prio') { State.filters.prio = State.filters.prio === t.dataset.val ? null : t.dataset.val; rerender(); }
  else if (act === 'epics-tab') { State.epicsTab = t.dataset.tab; rerender(); }
  else if (act === 'toggle-epic') { const id = t.dataset.id; State.epicsExpanded.has(id) ? State.epicsExpanded.delete(id) : State.epicsExpanded.add(id); rerender(); }
}

/* ---- global search ---- */
function wireGlobalSearch() {
  const input = $('#globalSearch'), box = $('#searchResults');
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { box.classList.remove('on'); box.innerHTML = ''; return; }
    const iss = State.issues.filter((i) => i.type !== 'epic' && (i.title.toLowerCase().includes(q) || String(i.id).toLowerCase().includes(q))).slice(0, 6);
    const eps = State.epics.filter((e) => e.title.toLowerCase().includes(q)).slice(0, 5);
    const dec = (State.snapshot.decisions || []).filter((d) => (d.title + ' ' + d.id).toLowerCase().includes(q)).slice(0, 5);
    const grp = (label, items, html) => items.length ? `<div class="sr-group">${label}</div>${items.map(html).join('')}` : '';
    box.innerHTML =
      grp('Issues', iss, (i) => `<div class="sr-item" data-nav="board" data-q="${esc(i.title)}">${typeBadge(i.type)}<span class="t">${esc(clamp(i.title, 52))}</span></div>`) +
      grp('Epics', eps, (e) => `<div class="sr-item" data-nav="epic" data-id="${esc(e.id)}"><span class="hdot" style="background:var(${HEALTH[epicHealth(e)].v})"></span><span class="t">${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 50))}</span></div>`) +
      grp('Decisions', dec, (d) => `<div class="sr-item" data-nav="decisions"><span class="stbadge accepted">${esc(d.status)}</span><span class="t">${esc(clamp(d.title, 46))}</span></div>`) ||
      `<div class="sr-empty">No matches for “${esc(q)}”.</div>`;
    box.classList.add('on');
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  box.addEventListener('click', (e) => {
    const it = e.target.closest('[data-nav]'); if (!it) return;
    const nav = it.dataset.nav;
    box.classList.remove('on'); input.value = '';
    if (nav === 'board') { State.board.epicFocus = null; State.board.level = 'tasks'; State.filters.q = it.dataset.q || ''; location.hash = '#/board'; }
    else if (nav === 'epic') { State.epicsExpanded.add(it.dataset.id); location.hash = '#/epics'; }
    else if (nav === 'decisions') { location.hash = '#/decisions'; }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.classList.remove('on'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !/input|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape') { box.classList.remove('on'); input.blur(); }
  });
}

/* ---- theme / refresh / stamp ---- */
function wireTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem('forge-theme'); if (saved) root.setAttribute('data-theme', saved);
  const paint = () => { const dark = root.getAttribute('data-theme') !== 'light'; $('#themeLabel').textContent = dark ? 'Light' : 'Dark'; $('#themeIcon').textContent = dark ? '◐' : '◑'; };
  paint();
  $('#themeToggle').addEventListener('click', () => { const dark = root.getAttribute('data-theme') !== 'light'; root.setAttribute('data-theme', dark ? 'light' : 'dark'); localStorage.setItem('forge-theme', dark ? 'light' : 'dark'); paint(); });
}
function updateStamp() {
  const g = State.snapshot.generated_at;
  $('#updatedText').textContent = 'updated ' + (g ? relTime(g) : '—');
  const when = g ? new Date(g) : new Date();
  $('#sidebarMeta').innerHTML = `snapshot ${esc(when.toISOString().slice(0, 16).replace('T', ' '))}Z<br>${State.issues.length} issues · read-only`;
  $('#brandVer').textContent = State.snapshot.status?.context?.branch ? esc(State.snapshot.status.context.branch) : 'kernel dashboard';
}
async function doRefresh(silent) {
  const btn = $('#refreshBtn');
  if (!silent) btn.classList.add('spin');
  try {
    const snap = await DataSource.refetch();
    rebuild(snap); buildNav(); route(); updateStamp();
  } catch (err) {
    if (!silent) { location.reload(); return; } // file:// — reload picks up regenerated snapshot.js
  } finally { btn.classList.remove('spin'); }
}

/* ---- boot ---- */
async function boot() {
  try {
    const snap = await DataSource.load();
    rebuild(snap);
    buildNav();
    wireTheme();
    wireGlobalSearch();
    $('#refreshBtn').addEventListener('click', () => doRefresh(false));
    $('#view').addEventListener('click', onViewClick);
    $('#menuBtn')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/overview';
    route();
    updateStamp();
    setInterval(updateStamp, 15000);
    setInterval(() => { if (document.visibilityState === 'visible') doRefresh(true); }, 60000);
  } catch (err) {
    $('#view').innerHTML = `<div class="empty-state"><h4>Could not load snapshot</h4><p>${esc(err.message)}</p><p>Run <code>node web/dashboard/generate-snapshot.mjs</code> to bake it.</p></div>`;
  }
}

if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { columnOf, matchesFilter, relTime, epicRollup, epicHealth, State };
}
