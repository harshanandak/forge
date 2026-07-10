/* Forge Dashboard v3 — read-only multi-view app, MONO/BRUTALIST skin.
   Consumes a baked kernel snapshot (window.FORGE_SNAPSHOT). No framework, no build.
   Grayscale-only encodings: fill density (priority), glyphs (status/health),
   a pulsing square (live claim), and a 6-cell stepper (lifecycle phase). */

/* ============================================================================
 * DataSource — the LIVE-VIEW SEAM.
 * ========================================================================== */
const DataSource = {
  async load() {
    if (window.FORGE_SNAPSHOT) return window.FORGE_SNAPSHOT;
    return (await fetch('data.json')).json();
  },
  async refetch() {
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
const PRIO_ALPHA = { P0: 1, P1: 0.66, P2: 0.42, P3: 0.2, P4: 0 };
const TYPE_LABEL = { feature: 'feat', task: 'task', bug: 'bug', epic: 'epic', decision: 'dec', chore: 'chore' };
const PHASES = ['plan', 'dev', 'validate', 'ship', 'review', 'verify'];

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60); if (m < 60) return m + 'm';
  const h = Math.round(m / 60); if (h < 24) return h + 'h';
  const dd = Math.round(h / 24); if (dd < 30) return dd + 'd';
  return d.toISOString().slice(0, 10);
}

function icon(name) {
  const p = {
    overview: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    board: '<rect x="3" y="3" width="5" height="18"/><rect x="10" y="3" width="5" height="12"/><rect x="17" y="3" width="5" height="15"/>',
    epics: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    decisions: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.5 6H14a2 2 0 0 1 2 2v2"/>',
    plans: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ops: '<path d="M3 12h4l2 6 4-14 2 8h6"/>',
    doc: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>',
  }[name] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter">${p}</svg>`;
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
// Best-effort "being worked on right now". Real liveness = kernel lease not expired
// (session_id + expires_at) — not yet exposed by the CLI; see the Live Ops seam.
function isLive(i) { return i.status === 'open' && !!i.claimed_by; }

// Best-effort lifecycle phase. Real stage (currentStage) is not yet on the kernel
// issue record — derived here from status/claim; seam noted in Live Ops + README.
function lifecyclePhase(i) {
  if (i.status === 'done') return { idx: 6, label: 'done' };
  if (i.status === 'cancelled') return { idx: 0, label: 'cancelled' };
  if (i.claimed_by) return { idx: 2, label: 'dev' };
  return { idx: 1, label: 'plan' };
}
function epicRollup(epic, kids) {
  kids = kids || State.kids[epic.id] || [];
  const total = kids.length;
  const done = kids.filter((k) => k.status === 'done').length;
  const blocked = kids.filter((k) => k.blocked && k.status === 'open').length;
  const inprog = kids.filter((k) => k.claimed_by && k.status === 'open' && !k.blocked).length;
  const live = kids.filter(isLive).length;
  return { total, done, blocked, inprog, live, open: total - done, ratio: total ? done / total : 0 };
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

/* ---------- grayscale encodings ---------- */
const prioTag = (p) => `<span class="prio" title="priority ${esc(p)}"><i style="background:rgba(var(--ink),${PRIO_ALPHA[p] ?? 0})"></i>${esc(p || '—')}</span>`;
const typeBadge = (t) => `<span class="badge">${esc(TYPE_LABEL[t] || t)}</span>`;
const STATUS_GLYPH = { done: '●', blocked: '✕', progress: '◐', ready: '○' };
const HEALTH_GLYPH = { ok: '●', warn: '◐', risk: '○', done: '●', neutral: '–' };
const HEALTH_LABEL = { ok: 'On track', warn: 'At risk', risk: 'Off track', done: 'Completed', neutral: '—' };
const pulse = (on) => (on ? '<span class="pulse" title="active claim — being worked on now"></span>' : '');
function phaseTag(i, dim) {
  const ph = lifecyclePhase(i);
  const cells = PHASES.map((_, n) => `<i class="${n < ph.idx ? 'on' : ''}"></i>`).join('');
  return `<span class="phase ${dim ? 'dim' : ''}" title="lifecycle: ${esc(ph.label)} (best-effort — no kernel stage field yet)"><span class="steps">${cells}</span><span class="lbl">${esc(ph.label)}</span></span>`;
}
const epicRef = (i) => {
  if (!i.parent_id) return '';
  const e = State.byId[i.parent_id]; if (!e) return '';
  return `<span class="epicref">${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 24))}</span>`;
};

function taskCard(i) {
  const owner = i.claimed_by ? `<span class="kcard__owner"><span class="av">${esc(i.claimed_by.slice(0, 2))}</span>${esc(i.claimed_by)}</span>` : '';
  return `<div class="kcard">
    <div class="kcard__top">${pulse(isLive(i))}${typeBadge(i.type)}${prioTag(i.priority)}<span class="kcard__id">${esc(String(i.id).slice(0, 8))}</span></div>
    <div class="kcard__title">${esc(clamp(i.title, 116))}</div>
    <div class="kcard__meta">${phaseTag(i)}${owner}${epicRef(i)}</div>
  </div>`;
}
function epicCard(e) {
  const r = epicRollup(e); const hg = HEALTH_GLYPH[epicHealth(e)];
  return `<div class="kcard kcard--epic" data-act="focus-epic" data-id="${esc(e.id)}">
    <div class="kcard__top"><span class="glyph">${hg}</span>${prioTag(e.priority)}<span class="kcard__id">${r.total} tasks</span></div>
    <div class="kcard__title">${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 108))}</div>
    <div class="kcard__roll"><div class="kcard__prog"><span style="width:${Math.round(r.ratio * 100)}%"></span></div>
      <span class="kcard__rolltext">${r.done}/${r.total || '·'}</span>${r.live ? `<span class="livecount">${pulse(true)}${r.live}</span>` : ''}</div>
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
  { id: 'plans', title: 'Plans', flush: false, render: renderPlans },
  { id: 'ops', title: 'Live Ops', flush: false, render: renderOps },
];

/* ---- Overview ---- */
function renderOverview() {
  const all = State.issues;
  const st = (k) => all.filter((i) => i.status === k).length;
  const total = all.length, done = st('done'), open = st('open');
  const donePct = total ? Math.round((done / total) * 100) : 0;
  const blocked = all.filter((i) => i.blocked && i.status !== 'done').length;
  const live = all.filter(isLive).length;
  const ready = all.filter((i) => columnOf(i) === 'ready').length;
  const c = State.snapshot.counts || {};

  const tiles = [
    { n: total, l: 'Total issues', s: State.snapshot.schema_version || '' },
    { n: donePct + '%', l: 'Complete', s: done + ' done' },
    { n: open, l: 'Open', s: ready + ' ready' },
    { n: live, l: 'Live now', s: c.actors + ' actors' },
    { n: blocked, l: 'Blocked', s: 'need unblocking' },
    { n: State.epics.length, l: 'Epics', s: (c.decisions || 0) + ' decisions' },
  ];
  const prio = {}; PRIO_ORDER.forEach((p) => (prio[p] = 0));
  all.forEach((i) => { if (prio[i.priority] != null) prio[i.priority]++; });
  const types = {}; all.forEach((i) => (types[i.type] = (types[i.type] || 0) + 1));

  const bar = PRIO_ORDER.map((p) => `<span title="${p}: ${prio[p]}" style="width:${(prio[p] / (total || 1)) * 100}%;background:rgba(var(--ink),${PRIO_ALPHA[p] ?? 0})"></span>`).join('');
  const legend = PRIO_ORDER.map((p) => `<span class="item"><span class="sw" style="background:rgba(var(--ink),${PRIO_ALPHA[p] ?? 0})"></span>${p} <b>${prio[p]}</b></span>`).join('');
  const chips = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span class="item"><span class="sw"></span>${esc(TYPE_LABEL[t] || t)} <b>${n}</b></span>`).join('');

  const recent = all.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 8)
    .map((i) => `<div class="rowline">${isLive(i) ? pulse(true) : `<span class="glyph">${STATUS_GLYPH[columnOf(i)] || '○'}</span>`}<span class="t">${esc(clamp(i.title, 68))}</span><span class="when">${esc(relTime(i.updated_at))}</span></div>`).join('');

  return `<div class="fade-in">
    <div class="stats">${tiles.map((t) => `<div class="stat"><div class="stat__num">${esc(t.n)}</div><div class="stat__label">${esc(t.l)}</div><div class="stat__sub">${esc(t.s)}</div></div>`).join('')}</div>
    <div class="overview-grid">
      <div class="panel"><h3>Priority distribution</h3><div class="bar">${bar}</div><div class="legend">${legend}</div></div>
      <div class="panel"><h3>Issue types</h3><div class="legend">${chips}</div></div>
    </div>
    <div class="overview-grid">
      <div class="panel"><h3>Recent activity</h3>${recent}</div>
      <div class="panel"><h3>Runtime</h3><div class="legend">
        <span class="item">Live claims <b>${live}</b></span><span class="item">Actors <b>${c.actors || 0}</b></span>
        <span class="item">Worktrees <b>${c.worktrees || 0}</b></span><span class="item">Open PRs <b>${c.prs || 0}</b></span>
      </div><div class="rowline" style="border:none;margin-top:12px"><a href="#/ops" class="slabel">→ Live Ops</a></div></div>
    </div>
  </div>`;
}

/* ---- Work Board ---- */
const TASK_COLS = [
  { key: 'ready', title: 'Ready' }, { key: 'progress', title: 'In progress' },
  { key: 'blocked', title: 'Blocked' }, { key: 'done', title: 'Done' },
];
const EPIC_COLS = [
  { key: 'ok', title: 'On track' }, { key: 'warn', title: 'At risk' },
  { key: 'risk', title: 'Off track' }, { key: 'done', title: 'Completed' },
];
function renderBoard() {
  const B = State.board;
  const focus = B.epicFocus ? State.byId[B.epicFocus] : null;
  const levelSeg = `<div class="seg">
    <button data-act="board-level" data-level="tasks" class="${B.level === 'tasks' ? 'on' : ''}">Tasks</button>
    <button data-act="board-level" data-level="epics" class="${B.level === 'epics' ? 'on' : ''}">Epics</button></div>`;
  const focusChip = focus ? `<span class="chipfilter">EPIC: ${esc(clamp(focus.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 32))}<button data-act="clear-focus" title="Clear">✕</button></span>` : '';
  let chips = '';
  if (B.level === 'tasks') {
    const types = [...new Set(State.issues.map((i) => i.type))].filter((t) => t && t !== 'epic');
    chips = `<div class="controls">${types.map((t) => `<button class="btn ${State.filters.type === t ? 'on' : ''}" data-act="chip-type" data-val="${t}">${esc(TYPE_LABEL[t] || t)}</button>`).join('')}
      ${PRIO_ORDER.map((p) => `<button class="btn ${State.filters.prio === p ? 'on' : ''}" data-act="chip-prio" data-val="${p}">${p}</button>`).join('')}</div>`;
  }
  const miniSearch = `<div class="minisearch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="boardSearch" type="search" placeholder="filter cards…" value="${esc(State.filters.q)}"></div>`;
  const cols = B.level === 'epics' ? renderEpicColumns() : renderTaskColumns(focus);
  return `<div class="boardbar">${levelSeg}${focusChip}${chips}${miniSearch}</div><div class="board">${cols}</div>`;
}
function column(col, cards, count, key) {
  const lim = State.board.limits[key] ?? 25;
  const shown = cards.slice(0, lim);
  const more = cards.length > lim ? `<button class="kmore" data-act="more" data-col="${key}">+${cards.length - lim} more</button>` : '';
  const body = shown.length ? shown.join('') + more : `<div class="kempty">— empty —</div>`;
  return `<div class="kcol"><div class="kcol__head"><span class="kcol__title">${esc(col.title)}</span><span class="kcol__count">${count}</span></div>
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
  State.epics.filter((e) => !State.filters.q || e.title.toLowerCase().includes(State.filters.q.toLowerCase()))
    .forEach((e) => { const h = epicHealth(e); const key = h === 'neutral' ? 'warn' : h; (buckets[key] || buckets.warn).push(e); });
  Object.keys(buckets).forEach((k) => buckets[k].sort((a, b) => epicRollup(b).total - epicRollup(a).total));
  return EPIC_COLS.map((c) => column(c, buckets[c.key].map(epicCard), buckets[c.key].length, 'e_' + c.key)).join('');
}

/* ---- Epics table ---- */
const EPIC_TABS = [{ id: 'active', label: 'Active' }, { id: 'planned', label: 'Planned' }, { id: 'completed', label: 'Completed' }, { id: 'all', label: 'All' }];
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
  const eps = State.epics.filter(epicTabMatch).sort((a, b) => epicRollup(b).total - epicRollup(a).total || new Date(b.updated_at) - new Date(a.updated_at));
  const rows = eps.map((e) => {
    const r = epicRollup(e); const h = epicHealth(e);
    const kids = State.kids[e.id] || [];
    const open = State.epicsExpanded.has(e.id);
    const sub = (e.labels || [])[0] ? `<div class="sub">${esc(e.labels[0])}</div>` : '';
    const active = `<span class="workdots">${r.live ? `<span class="wd">${pulse(true)}${r.live} live</span>` : ''}${r.blocked ? `<span class="wd"><span class="glyph">✕</span>${r.blocked}</span>` : ''}${!r.live && !r.blocked ? '<span class="wd">—</span>' : ''}</span>`;
    const parent = `<tr>
      <td><div class="rowname">
        <span class="chev ${kids.length ? '' : 'leaf'}" data-act="toggle-epic" data-id="${esc(e.id)}">${kids.length ? (open ? '▾' : '▸') : ''}</span>
        <span><span class="tt" data-act="focus-epic" data-id="${esc(e.id)}" style="cursor:pointer">${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 66))}</span>${sub}</span>
      </div></td>
      <td class="num" style="color:var(--faint)">—</td>
      <td><span class="health"><span class="glyph">${HEALTH_GLYPH[h]}</span><span class="slabel">${HEALTH_LABEL[h]}</span></span></td>
      <td><div class="progresscell"><div class="mini"><span style="width:${Math.round(r.ratio * 100)}%"></span></div><span class="frac">${r.done}/${r.total || '·'}</span></div></td>
      <td>${active}</td>
      <td><span class="trend">${esc(relTime(e.updated_at))}</span></td></tr>`;
    let children = '';
    if (open) {
      children = kids.slice().sort((a, b) => (a.status === 'done') - (b.status === 'done')).map((k) => `<tr class="child">
        <td><div class="rowname"><span class="chev leaf"></span>${isLive(k) ? pulse(true) : `<span class="glyph">${STATUS_GLYPH[columnOf(k)] || '○'}</span>`}<span class="tt">${esc(clamp(k.title, 58))}</span></div></td>
        <td>${phaseTag(k, true)}</td>
        <td><span class="slabel">${esc(k.blocked ? 'blocked' : k.status)}</span></td>
        <td>${prioTag(k.priority)}</td>
        <td>${k.claimed_by ? `<span class="kcard__owner"><span class="av">${esc(k.claimed_by.slice(0, 2))}</span>${esc(k.claimed_by)}</span>` : ''}</td>
        <td><span class="trend">${esc(relTime(k.updated_at))}</span></td></tr>`).join('');
    }
    return parent + children;
  }).join('');
  const body = eps.length ? `<div class="tblwrap"><table class="tbl">
    <thead><tr><th>Name</th><th>Target</th><th>Health</th><th>Progress</th><th>Active</th><th>Activity</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h4>No epics in this tab</h4><p>Try “All”.</p></div>`;
  return `<div class="fade-in"><div class="viewhead">${tabs}<div class="topbar__spacer"></div><span class="crumb">${eps.length} initiatives · row title → open in board</span></div>${body}</div>`;
}

/* ---- Decisions ---- */
function renderDecisions() {
  const decs = State.snapshot.decisions || [];
  const groups = [{ key: 'kernel', label: 'Kernel decisions' }, { key: 'headline', label: 'Architecture decisions (headline)' }, { key: 'adr', label: 'ADRs' }];
  const statusClass = (s) => { const l = (s || '').toLowerCase(); if (l.startsWith('accept')) return 'accepted'; if (l.startsWith('propos')) return 'proposed'; if (l.startsWith('supersed')) return 'superseded'; if (l.startsWith('deprecat')) return 'deprecated'; if (l === 'done') return 'done'; return ''; };
  const card = (d) => `<div class="deccard">
    <div class="deccard__top"><span class="stbadge ${statusClass(d.status)}">${esc(d.status || 'open')}</span>${d.component ? `<span class="badge">${esc(clamp(d.component, 26))}</span>` : ''}</div>
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
  html += arch.length ? `<div class="arch-list">${arch.map((a) => `<div class="arch-row"><span class="glyph">▦</span><span>${esc(a.title)}</span><span class="p">${esc(a.path)}</span></div>`).join('')}</div>`
    : `<div class="empty-state"><h4>No architecture docs</h4><p>Add records under docs/architecture/ or docs/adr/.</p></div>`;
  if (!decs.length) html += `<div class="empty-state"><h4>No decisions</h4><p>Kernel type=decision issues + headline PDs appear here.</p></div>`;
  return html + '</div>';
}

/* ---- Plans ---- */
function renderPlans() {
  const plans = (State.snapshot.plans || []).slice();
  const monthLabel = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Undated';
  const groups = {};
  plans.forEach((p) => { const m = p.date ? p.date.slice(0, 7) : 'zzzz'; (groups[m] = groups[m] || []).push(p); });
  const months = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const tag = (on, label) => on ? `<span class="badge">${label}</span>` : '';
  let html = `<div class="fade-in"><div class="viewhead"><span class="crumb">${plans.length} work folders · newest first</span></div>`;
  months.forEach((m) => {
    html += `<div class="tl-month">${esc(groups[m][0].date ? monthLabel(groups[m][0].date) : 'Undated')}</div>`;
    groups[m].forEach((p) => {
      html += `<div class="tl-row"><span class="tl-date">${esc(p.date || '—')}</span>
        <div><div class="tl-title">${esc(clamp(p.title, 84))}</div><div class="tl-slug">${esc(p.slug)}</div></div>
        <div class="tl-tags">${tag(p.hasPlan, 'plan')}${tag(p.hasTasks, 'tasks')}${tag(p.hasDecisions, 'decisions')}<span class="badge">${p.docCount} docs</span></div></div>`;
    });
  });
  return html + '</div>';
}

/* ---- Live Ops (multi-harness / multi-region) ---- */
function renderOps() {
  const ops = State.snapshot.ops || { worktrees: [], prs: [], activeClaims: [] };
  const claims = ops.activeClaims || [];
  const trees = ops.worktrees || [];
  const prs = ops.prs || [];
  const seam = State.snapshot.liveSeam || { exposed: [], pending: [] };

  const actors = {};
  claims.forEach((c) => { (actors[c.owner || '—'] = actors[c.owner || '—'] || []).push(c); });
  const actorNames = Object.keys(actors).sort((a, b) => actors[b].length - actors[a].length);

  const top = `<div class="ops-top">
    <div class="cell"><div class="n">${actorNames.length}</div><div class="l">Active actors</div></div>
    <div class="cell"><div class="n">${claims.length}</div><div class="l">Live claims</div></div>
    <div class="cell"><div class="n">${trees.length}</div><div class="l">Worktrees</div></div>
    <div class="cell"><div class="n">${prs.length}</div><div class="l">Open PRs</div></div>
  </div>`;

  const actorCards = actorNames.length ? actorNames.map((name) => {
    const items = actors[name];
    const lines = items.map((c) => `<div class="opsline">${pulse(true)}<span class="t">${esc(clamp(c.title, 52))}</span>${prioTag(c.priority)}<span class="when">${esc(relTime(c.updated_at))}</span></div>`).join('');
    return `<div class="actorcard"><div class="actorcard__head"><span class="kcard__owner"><span class="av">${esc(name.slice(0, 2))}</span></span><span class="actorcard__name">${esc(name)}</span><span class="actorcard__meta">${items.length} live</span></div>${lines}</div>`;
  }).join('') : `<div class="empty-state"><h4>No active actors</h4><p>Claimed-and-open issues (actor = claimed_by) appear here.</p></div>`;

  const prList = prs.length ? prs.map((p) => `<div class="opsline"><span class="pr-num">#${esc(p.number)}</span><span class="t">${esc(clamp(p.title, 54))}</span>${p.isDraft ? '<span class="badge">draft</span>' : ''}<span class="slabel">${esc((p.state || '').toLowerCase())}</span></div>`).join('')
    : `<div class="empty-state"><h4>No open PRs</h4><p>gh pr list returned none.</p></div>`;

  const bySurface = {};
  trees.forEach((w) => { (bySurface[w.surface || 'other'] = bySurface[w.surface || 'other'] || []).push(w); });
  const SURFACE_LABEL = { 'claude-code': 'Claude Code agents', worktree: 'Local worktrees', t3code: 't3code', ephemeral: 'Ephemeral / cloud', main: 'Main checkout', other: 'Other' };
  const surfaceHtml = Object.keys(bySurface).sort((a, b) => bySurface[b].length - bySurface[a].length).map((s) => {
    const lines = bySurface[s].map((w) => `<div class="opsline"><span class="pr-num mono" style="min-width:0">${esc(w.branch || '(detached)')}</span><span class="surface-tag">${esc(s)}</span><span class="t mono-path">${esc(w.path)}</span><span class="when">${esc(w.head || '')}</span></div>`).join('');
    return `<div class="actorcard"><div class="actorcard__head"><span class="actorcard__name">${esc(SURFACE_LABEL[s] || s)}</span><span class="actorcard__meta">${bySurface[s].length}</span></div>${lines}</div>`;
  }).join('');

  return `<div class="fade-in">${top}
    <div class="ops-grid">
      <div><div class="section-title" style="margin-top:0">Active agents · what each is working on</div>${actorCards}</div>
      <div><div class="section-title" style="margin-top:0">Open pull requests · ${prs.length}</div>${prList}</div>
    </div>
    <div class="section-title">Worktrees by surface · ${trees.length}</div>${surfaceHtml}
    <div class="seam"><b>SEAM — multi-harness/region.</b> Exposed by the CLI today: ${esc(seam.exposed.join(', '))}. Pending (present in the kernel lease table, not yet in the read surface): ${esc(seam.pending.join(', '))}. Harness/surface here is <b>inferred from the worktree path</b>; the real harness + region tag arrives with the sync-rail / Phase-2 lease read.</div>
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
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v.id));
  const view = $('#view');
  view.classList.toggle('view--flush', !!v.flush);
  view.innerHTML = v.render();
  view.scrollTop = 0;
  afterRender();
}
function afterRender() {
  const bs = $('#boardSearch');
  if (bs) bs.addEventListener('input', (e) => { State.filters.q = e.target.value.trim(); rerender(); });
}
function rerender() { const v = currentView(); const view = $('#view'); const focus = document.activeElement?.id; view.innerHTML = v.render(); afterRender(); if (focus === 'boardSearch') { const el = $('#boardSearch'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } }

function buildNav() {
  const counts = { board: State.issues.filter((i) => i.type !== 'epic').length, epics: State.epics.length, decisions: (State.snapshot.decisions || []).length, plans: (State.snapshot.plans || []).length, ops: (State.snapshot.ops?.activeClaims || []).length };
  $('#nav').innerHTML = `<div class="nav__label">Views</div>` + VIEWS.map((v) =>
    `<a href="#/${v.id}" data-view="${v.id}">${icon(v.id)}<span>${esc(v.title)}</span>${counts[v.id] != null ? `<span class="n">${counts[v.id]}</span>` : ''}</a>`).join('');
}

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
      grp('Issues', iss, (i) => `<div class="sr-item" data-nav="board" data-q="${esc(i.title)}">${isLive(i) ? pulse(true) : typeBadge(i.type)}<span class="t">${esc(clamp(i.title, 50))}</span></div>`) +
      grp('Epics', eps, (e) => `<div class="sr-item" data-nav="epic" data-id="${esc(e.id)}"><span class="glyph">${HEALTH_GLYPH[epicHealth(e)]}</span><span class="t">${esc(clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 48))}</span></div>`) +
      grp('Decisions', dec, (d) => `<div class="sr-item" data-nav="decisions"><span class="badge">${esc(clamp(d.status, 8))}</span><span class="t">${esc(clamp(d.title, 44))}</span></div>`) ||
      `<div class="sr-empty">No matches for “${esc(q)}”.</div>`;
    box.classList.add('on');
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  box.addEventListener('click', (e) => {
    const it = e.target.closest('[data-nav]'); if (!it) return;
    box.classList.remove('on'); input.value = '';
    const nav = it.dataset.nav;
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

function wireTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem('forge-theme'); if (saved) root.setAttribute('data-theme', saved);
  const paint = () => { const dark = root.getAttribute('data-theme') !== 'light'; $('#themeLabel').textContent = dark ? 'Light' : 'Dark'; };
  paint();
  $('#themeToggle').addEventListener('click', () => { const dark = root.getAttribute('data-theme') !== 'light'; root.setAttribute('data-theme', dark ? 'light' : 'dark'); localStorage.setItem('forge-theme', dark ? 'light' : 'dark'); paint(); });
}
function updateStamp() {
  const g = State.snapshot.generated_at;
  $('#updatedText').textContent = 'updated ' + (g ? relTime(g) + ' ago' : '—');
  const when = g ? new Date(g) : new Date();
  $('#sidebarMeta').innerHTML = `snapshot<br>${esc(when.toISOString().slice(0, 16).replace('T', ' '))}Z<br>${State.issues.length} issues · read-only`;
  $('#brandVer').textContent = State.snapshot.status?.context?.branch ? esc(State.snapshot.status.context.branch) : 'kernel';
}
async function doRefresh(silent) {
  const btn = $('#refreshBtn');
  if (!silent) btn.classList.add('spin');
  try { const snap = await DataSource.refetch(); rebuild(snap); buildNav(); route(); updateStamp(); }
  catch (err) { if (!silent) { location.reload(); return; } }
  finally { btn.classList.remove('spin'); }
}

async function boot() {
  try {
    const snap = await DataSource.load();
    rebuild(snap);
    buildNav(); wireTheme(); wireGlobalSearch();
    $('#refreshBtn').addEventListener('click', () => doRefresh(false));
    $('#view').addEventListener('click', onViewClick);
    $('#menuBtn')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/overview';
    route(); updateStamp();
    setInterval(updateStamp, 15000);
    setInterval(() => { if (document.visibilityState === 'visible') doRefresh(true); }, 60000);
  } catch (err) {
    $('#view').innerHTML = `<div class="empty-state"><h4>Could not load snapshot</h4><p>${esc(err.message)}</p><p>Run node web/dashboard/generate-snapshot.mjs</p></div>`;
  }
}
if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { columnOf, matchesFilter, relTime, epicRollup, epicHealth, isLive, lifecyclePhase, State };
}
