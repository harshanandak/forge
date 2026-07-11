/* Forge Dashboard v6 — read-only multi-view app, MONO/BRUTALIST skin (dark-default).
   Consumes a baked kernel snapshot (window.FORGE_SNAPSHOT) + baked work-folder
   markdown (window.FORGE_DOCS). No framework, no build.

   v6 (Fable design pass): every entity is a URL (route-driven detail, Back closes);
   ONE unified card (status/pulse · title · owner — 3-item budget; phase/badge/id
   live in the detail hub); status is the only board axis, epics are grouping headers;
   Live Ops → one joined "Now" list. Two-tier type: sans titles, mono for data. */

/* ============================================================================
 * DataSource — the LIVE-VIEW SEAM.
 * ========================================================================== */
const DataSource = {
  async load() {
    if (window.FORGE_SNAPSHOT) return window.FORGE_SNAPSHOT;
    return (await fetch('data.json')).json();
  },
  async refetch() {
    const ts = '?ts=' + Date.now();
    const res = await fetch('data.json' + ts, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const snap = await res.json();
    // Refresh the baked markdown too, so edited/new work-folder docs aren't stale
    // until a full reload. Best-effort: an old snapshot.js bundle may predate docs.json.
    try {
      const dres = await fetch('docs.json' + ts, { cache: 'no-store' });
      if (dres.ok) window.FORGE_DOCS = await dres.json();
    } catch (_err) { /* keep the bootstrap docs if the twin is unavailable */ }
    return snap;
  },
  subscribe() { /* TODO(sync-rail): new EventSource('/events') → onDelta(patch) */ },
};

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const deEpic = (t) => String(t || '').replace(/^\[?EPIC\]?:?\s*/i, '');

const PRIO_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4'];
const PRIO_ALPHA = { P0: 1, P1: 0.66, P2: 0.42, P3: 0.2, P4: 0 };
const TYPE_LABEL = { epic: 'epic', task: 'task', bug: 'bug', feature: 'feature', decision: 'decision', chore: 'chore' };
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
    architecture: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.5 6H14a2 2 0 0 1 2 2v2"/>',
    plans: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ops: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    doc: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>',
    workspaces: '<rect x="3" y="4" width="18" height="14"/><path d="M3 9h18M8 4v5"/>',
    memory: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="9" cy="17" r="2"/><path d="M8 6h8M7 8l1.5 7M16 9l-6 7"/>',
    backlog: '<path d="M3 4h18v6H3zM3 14h18v6H3"/><path d="M7 7h4M7 17h4"/>',
  }[name] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter">${p}</svg>`;
}

/* ---------- state ---------- */
const State = {
  snapshot: null, issues: [], epics: [], byId: {}, kids: {},
  filters: { q: '', types: new Set(), prios: new Set() },
  board: { epicFocus: null, limits: {}, showClosed: false, mode: 'kanban', tableCollapsed: new Set() },
  epicsTab: 'active', epicsExpanded: new Set(), archExpanded: new Set(),
  wsArchived: false, memFilter: '',
  route: 'overview', rendered: null,
};
function rebuild(snap) {
  State.snapshot = snap;
  const issues = (snap.issues || []).filter((i) => i && i.type !== 'zzzbogus');
  State.issues = issues;
  State.byId = {}; State.kids = {};
  issues.forEach((i) => { State.byId[i.id] = i; if (i.parent_id) (State.kids[i.parent_id] = State.kids[i.parent_id] || []).push(i); });
  State.epics = issues.filter((i) => i.type === 'epic');
  // Grounded work-folder ↔ issue links: issues that reference docs/work/<slug> in
  // their body/design/notes (real citation, not fuzzy title matching). The rest is
  // a SEAM (the work-graph 56461780) — no back-ref field on the kernel record yet.
  State.workLinks = { bySlug: {}, byIssue: {} };
  const slugSet = new Set((snap.plans || []).map((p) => p.slug));
  const RE = /docs\/work\/(\d{4}-\d{2}-\d{2}-[a-z0-9._-]+)/gi;
  issues.forEach((i) => {
    const hay = `${i.body || ''}\n${i.design || ''}\n${i.notes || ''}\n${i.acceptance_criteria || ''}`;
    const found = new Set();
    for (const m of hay.matchAll(RE)) { if (slugSet.has(m[1])) found.add(m[1]); }
    if (found.size) {
      State.workLinks.byIssue[i.id] = [...found];
      found.forEach((s) => { (State.workLinks.bySlug[s] = State.workLinks.bySlug[s] || []).push(i.id); });
    }
  });
}

/* ---------- pure derivation (exported for tests) ---------- */
function columnOf(i) {
  if (i.status === 'done') return 'done';
  if (i.status === 'cancelled') return null;
  if (i.status === 'backlog') return 'backlog'; // real kernel backlog state (b2f856b1)
  if (i.blocked) return 'blocked'; // blocked = a card glyph, not a column (stays visible in Ready)
  if (i.claimed_by) return 'progress';
  return 'ready';
}
function matchesFilter(i) {
  const f = State.filters;
  if (f.types && f.types.size && !f.types.has(i.type)) return false;
  if (f.prios && f.prios.size && !f.prios.has(i.priority)) return false;
  if (f.q) {
    const hay = (i.title + ' ' + i.id + ' ' + (i.claimed_by || '') + ' ' + (i.labels || []).join(' ')).toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}
function isLive(i) { return i.status === 'open' && !!i.claimed_by; }
// Phase from real signals only (kernel has no currentStage — SEAM a2279f65). A done
// issue is shipped; a claimed-open issue is in progress with the remaining stage UNKNOWN.
function lifecyclePhase(i) {
  if (i.status === 'done') return { idx: 6, label: 'shipped' };
  if (i.status === 'cancelled') return { idx: 0, label: 'cancelled' };
  if (i.claimed_by) return { idx: 2, label: 'in progress', unknown: true };
  return { idx: 1, label: 'planned' };
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
function wtSummary(w) {
  return {
    ahead: w.ahead ?? null, behind: w.behind ?? null, dirty: w.dirty ?? null,
    hasGit: w.ahead != null || w.behind != null,
    clean: w.dirty === 0, archived: !!w.archived, pr: w.pr || null,
  };
}
const rankByPrio = (a, b) => (({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }[a.priority] ?? 9) - ({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }[b.priority] ?? 9));

/* ---------- keyboard a11y (pure, exported for tests) ---------- */
// Cards / rows / area-nodes are click-driven [data-act] divs. To make them
// keyboard-operable we give the non-native ones button semantics and treat
// Enter / Space as activation. Elements that are already operable (a, button,
// input, or an explicit tabindex) are left untouched — the browser handles them.
const NATIVE_INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
function isActivationKey(key) { return key === 'Enter' || key === ' ' || key === 'Spacebar'; }
function needsButtonSemantics(tagName) { return !NATIVE_INTERACTIVE.has(String(tagName || '').toUpperCase()); }

/* ---------- grayscale encodings ---------- */
const STATUS_GLYPH = { done: '●', blocked: '✕', progress: '◐', ready: '○', backlog: '◇' };
const ATTN_GLYPH = { ready: '●', fail: '✕', open: '○', warn: '◐' };
const HEALTH_GLYPH = { ok: '●', warn: '◐', risk: '○', done: '●', neutral: '–' };
const HEALTH_LABEL = { ok: 'On track', warn: 'At risk', risk: 'Off track', done: 'Completed', neutral: '—' };
const pulse = (on) => (on ? '<span class="pulse" title="active claim — being worked on now"></span>' : '');
const pmark = (p) => (p ? `<span class="pmark" title="priority ${esc(p)}">${esc(p)}</span>` : '');
// progress bar + n/m fraction — the SAME everywhere (board, epics, detail).
function progress(r) {
  return `<span class="prog"><span class="prog__bar"><span style="width:${Math.round(r.ratio * 100)}%"></span></span><span class="prog__frac">${r.done}/${r.total || '·'}</span>${r.live ? `<span class="prog__live">${pulse(true)}${r.live}</span>` : ''}</span>`;
}
// 6-cell stepper — DETAIL ONLY now (removed from cards per the diet).
function phaseTag(i) {
  const ph = lifecyclePhase(i);
  const cells = PHASES.map((_, n) => n < ph.idx ? '<i class="on"></i>' : (ph.unknown ? '<i class="unk"></i>' : '<i></i>')).join('');
  const t = ph.unknown ? `${ph.label} · exact stage unknown (SEAM a2279f65)` : ph.label;
  return `<span class="phase" title="lifecycle: ${esc(t)}"><span class="steps">${cells}</span><span class="lbl">${esc(ph.label)}</span></span>`;
}

/* ---------- THE unified card (budget = 3: status/pulse · title · owner) ---------- */
// One component for board, epic grid, memory, search, detail children. Epics add a
// progress bar + fraction (the same one used everywhere). No per-card phase/badge/id.
function card(i) {
  const live = isLive(i);
  const lead = live ? pulse(true) : `<span class="glyph">${STATUS_GLYPH[columnOf(i)] || '○'}</span>`;
  const owner = i.claimed_by ? `<span class="card__owner">${esc(i.claimed_by)}</span>` : '';
  const kind = i.type === 'epic' ? 'epic' : 'issue';
  if (i.type === 'epic') {
    const r = epicRollup(i);
    return `<div class="card card--epic" data-act="open" data-kind="epic" data-id="${esc(i.id)}">
      <div class="card__line"><span class="glyph" title="${esc(HEALTH_LABEL[epicHealth(i)])}">${HEALTH_GLYPH[epicHealth(i)]}</span>${pmark(i.priority)}<span class="card__title">${esc(clamp(deEpic(i.title), 116))}</span></div>
      <div class="card__foot">${progress(r)}</div>
    </div>`;
  }
  return `<div class="card" data-act="open" data-kind="${kind}" data-id="${esc(i.id)}">
    <div class="card__line">${lead}${pmark(i.priority)}<span class="card__title">${esc(clamp(i.title, 116))}</span></div>
    ${owner ? `<div class="card__foot">${owner}</div>` : ''}
  </div>`;
}

/* ============================================================================
 * VIEWS
 * ========================================================================== */
const VIEWS = [
  { id: 'overview', title: 'Overview', flush: false, render: renderOverview },
  { id: 'board', title: 'Work Board', flush: true, render: renderBoard },
  { id: 'epics', title: 'Epics', flush: false, render: renderEpics },
  { id: 'workspaces', title: 'Workspaces', flush: false, render: renderWorkspaces },
  { id: 'backlog', title: 'Backlog', flush: false, render: renderBacklog },
  { id: 'architecture', title: 'Architecture', flush: false, render: renderArchitecture },
  { id: 'plans', title: 'Work folders', flush: false, render: renderPlans },
  { id: 'memory', title: 'Memory', flush: false, render: renderMemory },
  { id: 'ops', title: 'Now', flush: false, render: renderNow },
];

/* ---- Overview ---- */
function renderOverview() {
  const all = State.issues;
  const st = (k) => all.filter((i) => i.status === k).length;
  const total = all.length, done = st('done'), open = st('open');
  const donePct = total ? Math.round((done / total) * 100) : 0;
  const blocked = all.filter((i) => i.blocked && i.status !== 'done').length;
  const live = all.filter(isLive).length;
  const c = State.snapshot.counts || {};

  const tiles = [
    { n: total, l: 'Total issues', s: State.epics.length + ' epics' },
    { n: donePct + '%', l: 'Complete', s: done + ' done' },
    { n: open, l: 'Open', s: live + ' live · ' + blocked + ' blocked' },
    { n: c.prs || 0, l: 'Open PRs', s: (c.worktrees || 0) + ' worktrees' },
  ];
  const types = {}; all.forEach((i) => (types[i.type] = (types[i.type] || 0) + 1));
  const typeRows = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
    `<div class="distrow"><span class="distlbl">${esc(TYPE_LABEL[t] || t)}</span><div class="distbar"><span style="width:${(n / (total || 1)) * 100}%"></span></div><b>${n}</b></div>`).join('');
  const prio = {}; PRIO_ORDER.forEach((p) => (prio[p] = 0));
  all.forEach((i) => { if (prio[i.priority] != null) prio[i.priority]++; });
  const prioRows = PRIO_ORDER.map((p) =>
    `<div class="distrow"><span class="distlbl">${p}</span><div class="distbar"><span style="width:${(prio[p] / (total || 1)) * 100}%;background:rgba(var(--ink),${PRIO_ALPHA[p] ?? 0})"></span></div><b>${prio[p]}</b></div>`).join('');

  const recent = all.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 8)
    .map((i) => `<div class="rowline" data-act="open" data-kind="${i.type === 'epic' ? 'epic' : 'issue'}" data-id="${esc(i.id)}">${isLive(i) ? pulse(true) : `<span class="glyph">${STATUS_GLYPH[columnOf(i)] || '○'}</span>`}<span class="t">${esc(clamp(i.title, 66))}</span><span class="when">${esc(relTime(i.updated_at))}</span></div>`).join('');

  return `<div class="fade-in">
    <div class="stats">${tiles.map((t) => `<div class="stat"><div class="stat__num">${esc(t.n)}</div><div class="stat__label">${esc(t.l)}</div><div class="stat__sub">${esc(t.s)}</div></div>`).join('')}</div>
    ${renderAttention()}
    <div class="overview-grid">
      <div class="panel"><h3>Issues by type</h3><div class="dist">${typeRows}</div></div>
      <div class="panel"><h3>Issues by priority</h3><div class="dist">${prioRows}</div></div>
    </div>
    <div class="overview-grid">
      <div class="panel"><h3>Recent activity</h3>${recent}</div>
      <div class="panel"><h3>Runtime</h3><div class="legend">
        <span class="item">Live claims <b>${live}</b></span><span class="item">Actors <b>${c.actors || 0}</b></span>
        <span class="item">Worktrees <b>${c.worktrees || 0}</b></span><span class="item">Open PRs <b>${c.prs || 0}</b></span>
      </div><div class="rowline" style="margin-top:12px"><a href="#/ops" class="slabel">→ Now</a> · <a href="#/workspaces" class="slabel">→ Workspaces</a></div></div>
    </div>
  </div>`;
}

/* ---- Work Board ---- (status = the only axis; epics = grouping headers) */
function renderBoard() {
  const B = State.board;
  const focus = B.epicFocus ? State.byId[B.epicFocus] : null;
  const focusChip = focus ? `<span class="chipfilter"><span class="glyph">${HEALTH_GLYPH[epicHealth(focus)]}</span>${esc(clamp(deEpic(focus.title), 34))}<button data-act="clear-focus" title="Clear">✕</button></span>` : '';
  // Persisted Kanban ⇄ Table toggle — same items, same filter bar; status stays the
  // sort geometry in both (columns in Kanban, sort order in Table).
  const modeSeg = `<div class="seg">
    <button data-act="board-mode" data-mode="kanban" class="${B.mode !== 'table' ? 'on' : ''}">Kanban</button>
    <button data-act="board-mode" data-mode="table" class="${B.mode === 'table' ? 'on' : ''}">Table</button></div>`;
  const closedToggle = `<button class="btn ${B.showClosed ? 'on' : ''}" data-act="board-closed">${B.showClosed ? 'Hide' : 'Show'} done / cancelled</button>`;
  const types = [...new Set(State.issues.map((i) => i.type))].filter((t) => t && t !== 'epic');
  const chips = `<div class="controls">${types.map((t) => `<button class="btn ${State.filters.types.has(t) ? 'on' : ''}" data-act="chip-type" data-val="${t}">${esc(TYPE_LABEL[t] || t)}</button>`).join('')}
    ${PRIO_ORDER.map((p) => `<button class="btn ${State.filters.prios.has(p) ? 'on' : ''}" data-act="chip-prio" data-val="${p}">${p}</button>`).join('')}
    ${(State.filters.types.size || State.filters.prios.size) ? '<button class="btn" data-act="chip-clear">clear</button>' : ''}</div>`;
  const miniSearch = `<div class="minisearch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="boardSearch" type="search" placeholder="filter…" value="${esc(State.filters.q)}"></div>`;
  const body = B.mode === 'table'
    ? `<div class="worklist">${renderTaskTable(focus)}</div>`
    : `<div class="board">${renderTaskColumns(focus)}</div>`;
  return `<div class="boardbar">${modeSeg}${closedToggle}${focusChip}${chips}${miniSearch}</div>${body}`;
}
function renderTaskColumns(focus) {
  let pool = State.issues.filter((i) => i.type !== 'epic' && matchesFilter(i));
  if (focus) pool = pool.filter((i) => i.parent_id === focus.id);
  const byRecent = (a, b) => new Date(b.closed_at || b.updated_at) - new Date(a.closed_at || a.updated_at);
  // Real kernel statuses now (backlog state b2f856b1 merged). Backlog = status
  // 'backlog' (parked; honest if empty). Blocked is NOT a column — blocked items
  // stay in Ready with a ✕ glyph (columnOf), so they're visible, not mislabeled.
  const g = { backlog: [], ready: [], progress: [] };
  pool.forEach((i) => {
    if (i.status === 'done' || i.status === 'cancelled') return;
    if (i.status === 'backlog') g.backlog.push(i);
    else if (i.blocked) g.ready.push(i); // blocked (even if claimed) stays in Ready with a ✕ glyph — matches columnOf()
    else if (i.claimed_by) g.progress.push(i);
    else g.ready.push(i);
  });
  const defs = [
    { key: 'backlog', title: 'Backlog', note: 'parked · not scheduled', items: g.backlog },
    { key: 'ready', title: 'Ready', items: g.ready },
    { key: 'progress', title: 'In progress', items: g.progress },
  ];
  if (State.board.showClosed) {
    defs.push(
      { key: 'done', title: 'Done', items: pool.filter((i) => i.status === 'done').sort(byRecent) },
      { key: 'cancelled', title: 'Cancelled', items: pool.filter((i) => i.status === 'cancelled').sort(byRecent) },
    );
  }
  // Epics-first = grouping, not a mode: outside an epic focus, tasks are grouped
  // under their epic header inside each status column.
  const grouped = !focus;
  return defs.map((d) => boardColumn(d, grouped)).join('');
}
function boardColumn(def, grouped) {
  const items = def.items.slice().sort(rankByPrio);
  const lim = State.board.limits[def.key] ?? 30;
  const shown = items.slice(0, lim);
  const more = items.length > lim ? `<button class="kmore" data-act="more" data-col="${def.key}">+${items.length - lim} more</button>` : '';
  let body;
  if (!shown.length) body = `<div class="kempty">— empty —</div>`;
  else if (grouped) {
    const byEpic = new Map();
    shown.forEach((i) => { const e = i.parent_id || '__none'; if (!byEpic.has(e)) byEpic.set(e, []); byEpic.get(e).push(i); });
    body = [...byEpic.entries()].map(([eid, list]) => {
      const e = eid !== '__none' ? State.byId[eid] : null;
      const hdr = e
        ? `<div class="epicgroup" data-act="open" data-kind="epic" data-id="${esc(e.id)}"><span class="glyph" title="${esc(HEALTH_LABEL[epicHealth(e)])}">${HEALTH_GLYPH[epicHealth(e)]}</span><span class="epicgroup__t">${esc(clamp(deEpic(e.title), 40))}</span><span class="n">${list.length}</span></div>`
        : `<div class="epicgroup epicgroup--none"><span class="epicgroup__t">No epic</span><span class="n">${list.length}</span></div>`;
      return hdr + list.map(card).join('');
    }).join('') + more;
  } else body = shown.map(card).join('') + more;
  const note = def.note ? `<span class="kcol__note">${esc(def.note)}</span>` : '';
  return `<div class="kcol"><div class="kcol__head"><span class="kcol__title">${esc(def.title)}</span>${note}<span class="kcol__count">${def.items.length}</span></div>
    <div class="kcol__body">${body}</div></div>`;
}

/* ---- Work Board · Table mode ---- (same items/filters; status = sort geometry) */
const STATUS_ORDER = { backlog: 0, ready: 1, blocked: 1, progress: 2, done: 3, cancelled: 4 };
const STATUS_WORD = { backlog: 'Backlog', ready: 'Ready', blocked: 'Blocked', progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const CANCEL_GLYPH = '–';
const statusKey = (i) => (i.status === 'cancelled' ? 'cancelled' : columnOf(i));
// Shared row atom (the Table counterpart of card() — same encodings, tabular).
function taskRow(i) {
  const col = statusKey(i);
  const g = STATUS_GLYPH[col] || (col === 'cancelled' ? CANCEL_GLYPH : '○');
  return `<tr class="taskrow" data-act="open" data-kind="issue" data-id="${esc(i.id)}">
    <td class="wt-title">${esc(clamp(i.title, 96))}</td>
    <td class="wt-status"><span class="glyph">${g}</span> ${esc(STATUS_WORD[col] || col)}</td>
    <td>${pmark(i.priority)}</td>
    <td class="wt-owner">${i.claimed_by ? esc(i.claimed_by) : '—'}</td>
    <td class="wt-live">${isLive(i) ? pulse(true) : ''}</td>
    <td class="wt-pr"><span class="seam-dash" title="issue↔PR link — SEAM ${esc(seamId('workFolderGraph', '56461780'))}">—</span></td>
  </tr>`;
}
function renderTaskTable(focus) {
  let pool = State.issues.filter((i) => i.type !== 'epic' && matchesFilter(i));
  if (focus) pool = pool.filter((i) => i.parent_id === focus.id);
  if (!State.board.showClosed) pool = pool.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
  // Group by epic (collapsible group rows); tasks with no epic go last.
  const groups = new Map();
  pool.forEach((i) => { const e = (i.parent_id && State.byId[i.parent_id]) ? i.parent_id : '__none'; if (!groups.has(e)) groups.set(e, []); groups.get(e).push(i); });
  const order = [...groups.keys()].sort((a, b) => {
    if (a === '__none') return 1; if (b === '__none') return -1;
    return rankByPrio(State.byId[a], State.byId[b]) || deEpic(State.byId[a].title).localeCompare(deEpic(State.byId[b].title));
  });
  const sortRows = (list) => list.sort((a, b) => (STATUS_ORDER[statusKey(a)] - STATUS_ORDER[statusKey(b)]) || rankByPrio(a, b));
  const rowsHtml = order.map((eid) => {
    const list = sortRows(groups.get(eid));
    const collapsed = State.board.tableCollapsed.has(eid);
    const chev = `<span class="chev" data-act="toggle-workgroup" data-id="${esc(eid)}">${collapsed ? '▸' : '▾'}</span>`;
    const e = eid !== '__none' ? State.byId[eid] : null;
    const head = e
      ? `<tr class="grouprow"><td colspan="6">${chev}<span class="glyph" title="${esc(HEALTH_LABEL[epicHealth(e)])}">${HEALTH_GLYPH[epicHealth(e)]}</span><span class="grouprow__t" data-act="open" data-kind="epic" data-id="${esc(e.id)}">${esc(clamp(deEpic(e.title), 64))}</span>${progress(epicRollup(e))}<span class="grouprow__n">${list.length}</span></td></tr>`
      : `<tr class="grouprow grouprow--none"><td colspan="6">${chev}<span class="grouprow__t">No epic</span><span class="grouprow__n">${list.length}</span></td></tr>`;
    return head + (collapsed ? '' : list.map(taskRow).join(''));
  }).join('');
  const body = pool.length ? rowsHtml : '<tr><td colspan="6"><div class="kempty">— no matching work —</div></td></tr>';
  return `<table class="worktbl"><thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>Owner</th><th>Live</th><th>PR</th></tr></thead><tbody>${body}</tbody></table>`;
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
        <span><span class="tt" data-act="open" data-kind="epic" data-id="${esc(e.id)}">${esc(clamp(deEpic(e.title), 66))}</span>${sub}</span>
      </div></td>
      <td><span class="health"><span class="glyph">${HEALTH_GLYPH[h]}</span><span class="slabel">${HEALTH_LABEL[h]}</span></span></td>
      <td>${progress(r)}</td>
      <td>${active}</td>
      <td><span class="trend">${esc(relTime(e.updated_at))}</span></td></tr>`;
    let children = '';
    if (open) {
      const cards = kids.slice().sort(rankByPrio).map(card).join('');
      children = `<tr class="childwrap"><td colspan="5" style="padding:12px"><div class="cardgrid">${cards}</div></td></tr>`;
    }
    return parent + children;
  }).join('');
  const body = eps.length ? `<div class="tblwrap"><table class="tbl">
    <thead><tr><th>Name</th><th>Health</th><th>Progress</th><th>Active</th><th>Activity</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h4>No epics in this tab</h4><p>Try “All”.</p></div>`;
  return `<div class="fade-in"><div class="viewhead">${tabs}<div class="topbar__spacer"></div><span class="crumb">${eps.length} initiatives · a name opens its detail hub</span></div>${body}</div>`;
}

/* ---- Architecture (decisions grouped into areas as folder-nodes) ---- */
function decStatusKey(s) {
  const l = (s || '').toLowerCase();
  if (l.startsWith('accept') || l === 'done') return 'accepted';
  if (l.startsWith('propos') || l === 'open') return 'proposed';
  if (l.startsWith('supersed')) return 'superseded';
  if (l.startsWith('deprecat')) return 'deprecated';
  return 'proposed';
}
const DEC_GLYPH = { accepted: '●', proposed: '○', superseded: '◐', deprecated: '✕' };
const SOURCE_LABEL = { kernel: 'kernel', headline: 'headline PD', adr: 'ADR' };
// Architecture area = the top segment of a decision's dotted/dashed component
// (authority.local.storage → authority; agent-interface.parity → agent).
function areaOf(component) { return component ? (String(component).split(/[.\-]/)[0] || 'general') : 'general'; }
function decCardHtml(d) {
  return `<div class="card" data-act="open" data-kind="decision" data-id="${esc(String(d.id))}">
    <div class="card__line"><span class="glyph" title="${esc(d.status || '')}">${DEC_GLYPH[decStatusKey(d.status)] || '○'}</span><span class="card__title">${esc(clamp(d.title, 110))}</span></div>
    <div class="card__foot"><span class="tag">${esc(SOURCE_LABEL[d.source] || d.source || '')}</span>${d.component ? `<span class="tag tag--soft">${esc(clamp(d.component, 26))}</span>` : ''}</div></div>`;
}
function renderArchitecture() {
  const decs = State.snapshot.decisions || [];
  const arch = State.snapshot.architecture || [];
  const areas = {};
  decs.forEach((d) => { const a = areaOf(d.component); (areas[a] = areas[a] || []).push(d); });
  const order = Object.keys(areas).sort((a, b) => areas[b].length - areas[a].length || a.localeCompare(b));
  const nodes = order.map((a) => {
    const list = areas[a].slice().sort((x, y) => (decStatusKey(x.status) === 'accepted' ? -1 : 1) - (decStatusKey(y.status) === 'accepted' ? -1 : 1));
    const accepted = list.filter((d) => decStatusKey(d.status) === 'accepted').length;
    const open = State.archExpanded.has(a);
    return `<div class="areanode ${open ? 'open' : ''}">
      <div class="areanode__head" data-act="toggle-area" data-id="${esc(a)}">
        <span class="chev">${open ? '▾' : '▸'}</span><span class="glyph">▦</span><span class="areanode__name">${esc(a)}</span>
        <span class="areanode__meta">${list.length} decision${list.length !== 1 ? 's' : ''} · ${accepted} accepted</span></div>
      ${open ? `<div class="areanode__body"><div class="cardgrid">${list.map(decCardHtml).join('')}</div>
        <div class="seamnote">How “${esc(a)}” evolved — supersede / relates / conflicts edges are a SEAM (${esc(seamId('workFolderGraph', '56461780'))}); decisions are grouped by area + status until the relation graph lands.</div></div>` : ''}
    </div>`;
  }).join('');
  const archList = arch.length
    ? `<div class="arch-list">${arch.map((a) => `<div class="arch-row"><span class="glyph">▦</span><span>${esc(a.title)}</span><span class="p">${esc(a.path)}</span></div>`).join('')}</div>`
    : `<div class="empty-state"><h4>No architecture docs</h4></div>`;
  return `<div class="fade-in">
    <div class="viewhead"><span class="crumb">${decs.length} decisions across ${order.length} architecture areas · open an area to see its decisions</span></div>
    <div class="arealist">${nodes || '<div class="empty-state"><h4>No decisions</h4><p>Kernel type=decision issues + headline PDs + ADRs appear here.</p></div>'}</div>
    <div class="section-title">Architecture docs · ${arch.length}</div>${archList}
  </div>`;
}

/* ---- Work folders ---- (each bundles plan+tasks+decisions+docs; linked to issues) */
function renderPlans() {
  const plans = (State.snapshot.plans || []).slice();
  const monthLabel = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Undated';
  const groups = {};
  plans.forEach((p) => { const m = p.date ? p.date.slice(0, 7) : 'zzzz'; (groups[m] = groups[m] || []).push(p); });
  const months = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const wfSeam = seamId('workFolderGraph', '56461780');
  const linkedIssues = (slug) => {
    const ids = State.workLinks.bySlug[slug] || [];
    if (!ids.length) return `<span class="seam-inline">linked epic / tasks — SEAM ${esc(wfSeam)}</span>`;
    const chips = ids.slice(0, 4).map((id) => { const it = State.byId[id]; return it ? `<span class="link wf-issue" data-act="open" data-kind="${it.type === 'epic' ? 'epic' : 'issue'}" data-id="${esc(id)}">${it.type === 'epic' ? '▲ ' : ''}${esc(clamp(deEpic(it.title), 32))}</span>` : ''; }).join('');
    return `<span class="wf-linked"><span class="wf-linked__k">${ids.length} linked</span>${chips}${ids.length > 4 ? `<span class="wf-more">+${ids.length - 4}</span>` : ''}</span>`;
  };
  const bundle = (p) => {
    const keys = docsFor(p.slug);
    const canRead = keys.length > 0;
    const files = keys.slice(0, 6).map((k) => `<span class="wf-file" ${canRead ? `data-act="open" data-kind="work" data-id="${esc(p.slug)}"` : ''}>${esc(fileLabel(k))}</span>`).join('') || '<span class="seam-inline">no baked docs</span>';
    return `<div class="wf-card ${canRead ? '' : 'nonread'}">
      <div class="wf-card__top"><span class="wf-card__title" ${canRead ? `data-act="open" data-kind="work" data-id="${esc(p.slug)}"` : ''}>${esc(clamp(p.title, 74))}${canRead ? ' <span class="readmark">read ↗</span>' : ''}</span><span class="wf-card__date">${esc(p.date || '—')}</span></div>
      <div class="wf-card__slug">${esc(p.slug)}</div>
      <div class="wf-files">${files}</div>
      <div class="wf-card__foot">${linkedIssues(p.slug)}</div>
    </div>`;
  };
  let html = `<div class="fade-in"><div class="viewhead"><span class="crumb">${plans.length} work folders · each bundles plan · tasks · decisions · docs · newest first</span></div>`;
  months.forEach((m) => {
    html += `<div class="tl-month">${esc(groups[m][0].date ? monthLabel(groups[m][0].date) : 'Undated')}</div><div class="wf-grid">${groups[m].map(bundle).join('')}</div>`;
  });
  return html + '</div>';
}

/* ---- Now ---- (ONE joined list: the active threads of work) */
function renderNow() {
  const ops = State.snapshot.ops || { worktrees: [], prs: [], activeClaims: [] };
  const claims = ops.activeClaims || [];
  const trees = ops.worktrees || [];
  const prs = ops.prs || [];
  const needs = (State.snapshot.needsAttention || []).length;
  const agents = new Set(claims.map((c) => c.owner)).size;

  const sentence = `<div class="nowline"><b>${agents}</b> agent${agents !== 1 ? 's' : ''} active · <b>${prs.length}</b> open PR${prs.length !== 1 ? 's' : ''} · <a href="#/overview" class="needslink"><b>${needs}</b> need${needs === 1 ? 's' : ''} you</a></div>`;

  // Each live claim = one active thread. The branch/PR join is a SEAM (issue↔worktree
  // linkage 56461780) — rendered as a slot so the shape is always visible.
  const seam = seamId('workFolderGraph', '56461780');
  const rows = claims.length ? claims.slice().sort(rankByPrio).map((c) => `<div class="nowrow" data-act="open" data-kind="issue" data-id="${esc(c.id)}">
    ${pulse(true)}<span class="card__owner">${esc(c.owner)}</span><span class="nowrow__t">${esc(clamp(c.title, 66))}</span>${pmark(c.priority)}<span class="nowrow__link">→ branch · PR <span class="seamtag">SEAM ${esc(seam)}</span></span><span class="when">${esc(relTime(c.updated_at))}</span>
  </div>`).join('') : `<div class="empty-state"><h4>Nothing running</h4><p>No open, claimed issues right now.</p></div>`;

  const prRows = prs.length ? prs.map((p) => {
    const ci = p.ci ? p.ci.state : '';
    const g = ci === 'pass' ? '●' : ci === 'fail' ? '✕' : ci ? '◐' : '';
    return `<div class="quietrow"><a href="${esc(p.url || '#')}" target="_blank" rel="noopener" class="pr-num">#${esc(p.number)}</a><span class="t">${esc(clamp(p.title, 60))}</span>${p.isDraft ? '<span class="tag">draft</span>' : ''}${g ? `<span class="glyph" title="CI ${esc(ci)}">${g}</span>` : ''}${p.ready ? '<span class="tag">ready</span>' : ''}</div>`;
  }).join('') : '<div class="kempty">— none —</div>';

  const wtRows = trees.filter((w) => !w.archived).slice(0, 12).map((w) =>
    `<div class="quietrow" data-act="goto" data-hash="#/workspaces"><span class="mono">${esc(w.branch || '(detached)')}</span><span class="t slabel">${esc(w.pr ? 'PR #' + w.pr.number : (w.mergedPr ? 'merged' : 'no PR'))}</span></div>`).join('') || '<div class="kempty">— none —</div>';

  return `<div class="fade-in now">
    ${sentence}
    <div class="section-title" style="margin-top:20px">Active now · ${claims.length}</div>
    <div class="nowlist">${rows}</div>
    <div class="overview-grid" style="margin-top:22px">
      <div class="panel"><h3>Open pull requests · ${prs.length}</h3>${prRows}</div>
      <div class="panel"><h3>Worktrees · ${trees.filter((w) => !w.archived).length} <a href="#/workspaces" class="slabel" style="float:right">all →</a></h3>${wtRows}</div>
    </div>
    <div class="seamnote">Real per-agent session · worktree · harness · region come from the kernel lease-read (${esc(seamId('harnessRegion', '7dc229d4'))}); today only <span class="mono">claimed_by</span> + git + PRs are exposed, so branch/PR↔issue joins above are SEAMs.</div>
  </div>`;
}

/* ---- Needs Attention lane ---- */
function renderAttention() {
  const items = State.snapshot.needsAttention || [];
  const rows = items.map((it) => `<div class="attn-row">
    <span class="glyph">${ATTN_GLYPH[it.glyph] || '○'}</span>
    <span class="subj">${esc(it.subject)}</span>
    <span class="det">${esc(clamp(it.detail, 78))}</span>
    <span class="why">${esc(it.why)}</span>
    ${it.link ? `<a class="go" href="${esc(it.link)}" target="_blank" rel="noopener">open ↗</a>` : ''}
  </div>`).join('');
  const empty = !items.length ? `<div class="attn-row"><span class="glyph">●</span><span class="det">Nothing needs you — all open PRs are clean or in flight.</span></div>` : '';
  const staleSeam = `<div class="attn-row"><span class="glyph">◐</span><span class="subj">Stale claims</span>
    <span class="det">lease near expiry / heartbeat gone — not derivable from the CLI yet</span>
    <span class="seamtag">SEAM ${esc(seamId('staleClaims', '7dc229d4'))}</span></div>`;
  return `<div class="attention">
    <div class="attention__head"><span class="glyph">△</span><span class="ttl">Needs Attention</span><span class="ct">${items.length} now</span></div>
    ${rows}${empty}${staleSeam}</div>`;
}

/* ---- Workspaces ---- (worktree = card; "working on" makes the relation explicit) */
const SURFACE_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', t3code: 't3code', cloud: 'Cloud', worktree: 'Local', main: 'Main', other: 'Unknown' };
function renderWorkspaces() {
  const trees = (State.snapshot.ops && State.snapshot.ops.worktrees) || [];
  const showArch = !!State.wsArchived;
  const list = trees.filter((w) => (showArch ? w.archived : !w.archived));
  const nActive = trees.filter((w) => !w.archived).length, nArch = trees.length - nActive;
  const toggle = `<div class="seg">
    <button data-act="ws-arch" data-v="0" class="${!showArch ? 'on' : ''}">Active ${nActive}</button>
    <button data-act="ws-arch" data-v="1" class="${showArch ? 'on' : ''}">Merged ${nArch}</button></div>`;
  const wcard = (w) => {
    const s = wtSummary(w);
    const working = w.pr ? `PR #${w.pr.number}` : (w.mergedPr ? `merged #${w.mergedPr}` : (w.branch || '(detached)'));
    const git = s.hasGit
      ? `<span class="gitstat">↑${s.ahead} ↓${s.behind} <span class="${s.clean ? '' : 'dirty'}">${s.clean ? 'clean' : s.dirty + ' dirty'}</span></span>`
      : `<span class="seam-inline">git — SEAM</span>`;
    const ci = w.pr ? `<span class="slabel">CI ${w.pr.ci === 'pass' ? '●' : w.pr.ci === 'fail' ? '✕' : '◐'}</span>${w.pr.ready ? '<span class="tag tag--hard">ready</span>' : ''}` : '';
    return `<div class="wt-card ${w.archived ? 'arch' : ''}">
      <div class="wt-card__top"><span class="wt-card__branch">${esc(w.branch || '(detached)')}</span><span class="tag">${esc(SURFACE_LABEL[w.surface] || w.surface)}</span></div>
      <div class="wt-working">on <b>${esc(working)}</b> ${ci}</div>
      <div class="wt-row">${git}<span class="mono k">${esc(w.head || '')}</span></div>
    </div>`;
  };
  const grid = list.length ? `<div class="cardgrid">${list.map(wcard).join('')}</div>` : `<div class="empty-state"><h4>No ${showArch ? 'merged' : 'active'} worktrees</h4></div>`;
  return `<div class="fade-in"><div class="viewhead">${toggle}<div class="topbar__spacer"></div><span class="crumb">each card = one git worktree · real ahead/behind/dirty + its PR</span></div>${grid}
    <div class="seamnote">Linked kernel issue · lifecycle phase · real harness/region — SEAM (worktree↔issue + lease-read ${esc(seamId('harnessRegion', '7dc229d4'))}).</div></div>`;
}

/* ---- Backlog ---- (real kernel backlog state b2f856b1; honest if empty) */
function renderBacklog() {
  const parked = State.issues.filter((i) => i.status === 'backlog').sort(rankByPrio);
  const grid = parked.length
    ? `<div class="cardgrid">${parked.map(card).join('')}</div>`
    : `<div class="empty-state"><h4>Nothing parked</h4>
        <p>No issues are in the kernel <span class="mono">backlog</span> state yet. Parked ideas / discussions land here and promote → task / epic.</p>
        <p style="margin-top:10px;color:var(--faint)">Blocked-but-open work is not "parked" — it stays on the Work Board (Ready column, marked with a ✕ blocked glyph).</p></div>`;
  return `<div class="fade-in"><div class="viewhead"><span class="crumb">parked ideas / discussions not yet scheduled · ${parked.length}</span></div>${grid}</div>`;
}

/* ---- Memory ---- (ONE reverse-chronological Memory Stream + Canon rail) */
function renderMemory() {
  const q = (State.memFilter || '').toLowerCase();
  const all = State.snapshot.decisions || [];
  const decs = all.filter((d) => !q || (d.title + ' ' + (d.component || '') + ' ' + (d.rationale || '')).toLowerCase().includes(q));
  const memN = Array.isArray(State.snapshot.memory) ? State.snapshot.memory.length : 0;
  const arch = State.snapshot.architecture || [];
  const acceptedN = all.filter((d) => decStatusKey(d.status) === 'accepted').length;

  const dated = decs.filter((d) => d.updated_at).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const undated = decs.filter((d) => !d.updated_at);
  const entry = (d) => `<div class="mentry" data-act="open" data-kind="decision" data-id="${esc(String(d.id))}">
    <span class="glyph mentry__g" title="decision">◇</span>
    <div class="mentry__main"><div class="mentry__text">${esc(clamp(d.title, 118))}</div>
      <div class="mentry__prov">${d.component ? `<span class="chip">${esc(areaOf(d.component))}</span>` : ''}<span class="chip">${esc(SOURCE_LABEL[d.source] || d.source || '')}</span><span class="chip">${esc(d.status || '')}</span></div></div>
    <span class="mentry__when">${esc(d.updated_at ? relTime(d.updated_at) : '—')}</span></div>`;
  const band = (label, list) => list.length ? `<div class="mband">${esc(label)} · ${list.length}</div>${list.map(entry).join('')}` : '';
  const stream = (dated.length || undated.length)
    ? band('Recent — dated decisions', dated) + band('Headline decisions — undated', undated)
    : `<div class="empty-state"><h4>No memory yet</h4><p><span class="mono">forge remember &lt;note&gt;</span> feeds this stream; decisions land here automatically.</p></div>`;

  const filt = `<div class="minisearch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="memFilter" type="search" placeholder="filter memory…" value="${esc(State.memFilter || '')}"></div>`;

  const canon = `<aside class="canon">
    <div class="canon__ttl">Canon</div>
    <div class="canon__row"><span>Accepted decisions</span><b>${acceptedN}</b></div>
    <div class="canon__row"><span>Architecture docs</span><b>${arch.length}</b></div>
    ${arch.map((a) => `<div class="canon__doc"><span class="glyph">▦</span>${esc(clamp(a.title, 30))}</div>`).join('')}
    <div class="canon__seam">Core-memories buffer is user-global (cross-project); a project-scoped Canon needs the memory ingestor (${esc(seamId('graphiti', 'c7971150'))}).</div>
  </aside>`;

  return `<div class="fade-in">
    <div class="viewhead"><span class="crumb">one reverse-chronological memory stream — what the project has learned</span><div class="topbar__spacer"></div>${filt}</div>
    <div class="mem-grid">
      <div class="mstream">
        ${stream}
        <div class="mband">forge recall · notes</div>
        <div class="seam"><b>${memN} recall entries.</b> The project remember-store is empty — entries land here as you <span class="mono">forge remember &lt;note&gt;</span>.</div>
        <div class="mband">.remember rotation</div>
        <div class="seam"><b>SEAM — user-global.</b> The <span class="mono">.remember</span> now / today / recent / archive buffers are user-global and mix projects, so they are deliberately <b>not</b> baked into this project stream (that would leak cross-project memory). A slug-scoped ingestor merges them here (${esc(seamId('graphiti', 'c7971150'))}).</div>
        <div class="section-title">Temporal threads</div>
        <div class="seamnote">Click any entry to open its thread — related decisions in the same architecture area. The full temporal graph (superseding / cross-links) is a SEAM until Graphiti (${esc(seamId('graphiti', 'c7971150'))}) is wired — no empty graph pane is shown.</div>
      </div>
      ${canon}
    </div>
  </div>`;
}

/* ============================================================================
 * Minimal Markdown → HTML (safe: escape first, then structure).
 * ========================================================================== */
function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let html = '', inCode = false, codeBuf = [], listType = null, para = [];
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (m, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`)
    .replace(/\[([^\]]+)\]\((?!https?:)([^)]+)\)/g, '<span class="mdlink">$1</span>');
  const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  const flushList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) { html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`; codeBuf = []; inCode = false; }
      else { flushPara(); flushList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flushPara(); flushList(); const lv = h[1].length; html += `<h${lv} class="md-h${lv}">${inline(h[2])}</h${lv}>`; continue; }
    if (/^\s*([-*])\s+/.test(line)) { flushPara(); if (listType !== 'ul') { flushList(); html += '<ul>'; listType = 'ul'; } html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`; continue; }
    if (/^\s*\d+\.\s+/.test(line)) { flushPara(); if (listType !== 'ol') { flushList(); html += '<ol>'; listType = 'ol'; } html += `<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`; continue; }
    if (/^\s*>\s?/.test(line)) { flushPara(); flushList(); html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); flushList(); html += '<hr>'; continue; }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    para.push(line.trim());
  }
  if (inCode) html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
  flushPara(); flushList();
  return html;
}
function docsFor(slug) { const d = window.FORGE_DOCS || {}; return Object.keys(d).filter((k) => k.startsWith(slug + '/')).sort(); }
function fileLabel(key) { return key.split('/').slice(1).join('/'); }

/* ============================================================================
 * Detail hub + doc reader — ROUTE-DRIVEN overlays.
 * ========================================================================== */
const seamId = (k, fb) => (String((State.snapshot.seams && State.snapshot.seams[k]) || fb).split(' ')[0]);
// The detail overlay is a modal dialog (role/aria-modal set in index.html). Track the
// element focused before it opened so focus can be restored when it closes.
let lastFocus = null;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';
function overlayFocusables() {
  return $$(FOCUSABLE, $('#detailPanel')).filter((el) => el.offsetParent !== null || el === document.activeElement);
}
function showOverlay(html, crumb) {
  const el = $('#detail');
  if (!el.classList.contains('on')) lastFocus = document.activeElement; // remember opener (once)
  $('#detailPanel').innerHTML = html;
  el.hidden = false; el.classList.add('on'); $('#detailPanel').scrollTop = 0;
  if (crumb != null) $('#viewCrumb').innerHTML = crumb;
  enhanceA11y($('#detailPanel'));
  // Move keyboard focus into the dialog (close button first, panel as fallback).
  ($('#detailPanel .detail__close') || $('#detailPanel')).focus();
}
// Keep Tab focus inside the open dialog.
function trapOverlayFocus(e) {
  if (e.key !== 'Tab' || $('#detail').hidden) return;
  const f = overlayFocusables(); if (!f.length) return;
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !$('#detailPanel').contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}
function issueDetailHtml(i) {
  const kids = State.kids[i.id] || [];
  const parent = i.parent_id ? State.byId[i.parent_id] : null;
  const childCards = kids.slice().sort(rankByPrio).map(card).join('');
  const seam = seamId('workFolderGraph', '56461780');
  const slot = (label, val, on) => `<div class="linkrow"><span class="linkrow__k">${esc(label)}</span><span class="linkrow__v">${on ? val : `<span class="seamtag">SEAM ${esc(seam)}</span>`}</span></div>`;
  const parentSlot = parent ? `<span class="link" data-act="open" data-kind="epic" data-id="${esc(parent.id)}">${esc(clamp(deEpic(parent.title), 44))}</span>` : '—';
  const r = i.type === 'epic' ? epicRollup(i) : null;
  // Grounded work-folder link (issue cites docs/work/<slug>); opens the in-render reader.
  const wfSlugs = State.workLinks.byIssue[i.id] || [];
  const wfVal = wfSlugs.map((s) => `<span class="link" data-act="open" data-kind="work" data-id="${esc(s)}">${esc(s)}</span>`).join(' · ');
  return `<button class="detail__close" data-act="detail-close">✕ esc</button>
    <div class="detail__eyebrow"><span class="tag">${esc(TYPE_LABEL[i.type] || i.type)}</span>${pmark(i.priority)}<span class="slabel">${esc(i.blocked ? 'blocked' : i.status)}</span>${isLive(i) ? pulse(true) : ''}${phaseTag(i)}</div>
    <h2 class="detail__title">${esc(deEpic(i.title))}</h2>
    ${r ? `<div class="detail__prog">${progress(r)}<a class="link" href="#/board?epic=${esc(i.id)}">see on board →</a></div>` : ''}
    <dl class="detail__grid">
      <dt>ID</dt><dd class="mono">${esc(i.id)}</dd>
      <dt>Status</dt><dd>${esc(i.status)}${i.blocked ? ' · blocked' : ''}</dd>
      <dt>Owner</dt><dd>${i.claimed_by ? esc(i.claimed_by) : '—'}</dd>
      <dt>Parent epic</dt><dd>${parentSlot}</dd>
      <dt>Labels</dt><dd>${(i.labels || []).map((l) => `<span class="tag">${esc(l)}</span>`).join(' ') || '—'}</dd>
      <dt>Deps</dt><dd>${(i.dependencies || []).length} dep · ${(i.dependents || []).length} dependents</dd>
      <dt>Updated</dt><dd class="mono">${esc(relTime(i.updated_at))} ago</dd>
    </dl>
    ${i.body ? `<div class="detail__body">${esc(clamp(i.body, 1400))}</div>` : ''}
    ${kids.length ? `<div class="section-title">Children · ${kids.length}</div><div class="cardgrid">${childCards}</div>` : ''}
    <div class="section-title">Linked work</div>
    <div class="linkgraph">
      ${slot('Parent epic', parentSlot, !!parent)}
      ${slot('Pull request', '', false)}
      ${slot('Worktree', '', false)}
      ${slot('Work folder', wfVal, wfSlugs.length > 0)}
      ${slot('Files changed', '', false)}
      ${slot('Comments', '', false)}
    </div>
    <div class="seamnote">This is the entity hub — every link slot is shown even when empty. PR / worktree / work-folder / files / comments fill in as the work-folder↔PR/issue graph (${esc(seam)}) lands.</div>`;
}
function decDetailHtml(d) {
  return `<button class="detail__close" data-act="detail-close">✕ esc</button>
    <div class="detail__eyebrow"><span class="tag">${esc(SOURCE_LABEL[d.source] || d.source || 'decision')}</span><span class="slabel">${esc(d.status || 'open')}</span>${d.component ? `<span class="tag tag--soft">${esc(d.component)}</span>` : ''}</div>
    <h2 class="detail__title">${esc(d.title)}</h2>
    <dl class="detail__grid"><dt>ID</dt><dd class="mono">${esc(String(d.id))}</dd><dt>Source</dt><dd>${esc(SOURCE_LABEL[d.source] || d.source || '—')}</dd><dt>Status</dt><dd>${esc(d.status || '—')}</dd></dl>
    ${d.rationale ? `<div class="detail__body">${esc(d.rationale)}</div>` : ''}
    ${decThreadHtml(d)}`;
}
// Click-through thread — related decisions in the same architecture area (degrades
// from a real temporal graph to an area/text match until Graphiti c7971150 is wired).
function decThreadHtml(d) {
  const area = areaOf(d.component);
  const related = (State.snapshot.decisions || []).filter((x) => String(x.id) !== String(d.id) && areaOf(x.component) === area).slice(0, 10);
  const list = related.length
    ? `<div class="cardgrid">${related.map(decCardHtml).join('')}</div>`
    : '<div class="kempty">— no related decisions in this area —</div>';
  return `<div class="section-title">Thread · “${esc(area)}” area</div>${list}
    <div class="seamnote">This thread is an <b>area/text match</b>. Real supersede / depends-on / conflict edges (${esc(seamId('workFolderGraph', '56461780'))}) and the temporal graph (${esc(seamId('graphiti', 'c7971150'))}) are seams not yet on the kernel record.</div>`;
}
function docReaderHtml(slug, keys, file) {
  const tabs = keys.map((k) => `<button class="doctab ${k === file ? 'on' : ''}" data-act="doc-file" data-slug="${esc(slug)}" data-file="${esc(k)}">${esc(fileLabel(k))}</button>`).join('');
  const content = renderMarkdown((window.FORGE_DOCS || {})[file]);
  return `<button class="detail__close" data-act="detail-close">✕ esc</button>
    <div class="detail__eyebrow"><span class="tag">work folder</span><span class="slabel">${esc(slug)}</span></div>
    <div class="doctabs">${tabs}</div>
    <article class="md">${content}</article>`;
}
// State for the reader (which file within the folder)
const DocState = { slug: null, file: null };

// Route-driven openers (called BY the router). Clicks navigate the hash; the router
// then renders the overlay. Back returns to the underlying view (closes overlay).
function showIssue(id) {
  const i = State.byId[id]; if (!i) return false;
  const parent = i.parent_id ? State.byId[i.parent_id] : null;
  const crumb = parent ? `<a href="#/epic/${esc(parent.id)}">${esc(clamp(deEpic(parent.title), 26))}</a> › ${esc(clamp(deEpic(i.title), 30))}` : `${esc(currentViewTitle())} › ${esc(clamp(deEpic(i.title), 34))}`;
  showOverlay(issueDetailHtml(i), crumb); return true;
}
function showDecision(id) {
  const d = (State.snapshot.decisions || []).find((x) => String(x.id) === String(id)); if (!d) return false;
  showOverlay(decDetailHtml(d), `Decisions › ${esc(clamp(d.title, 34))}`); return true;
}
function showWork(slug, file) {
  const keys = docsFor(slug);
  if (!keys.length) { showOverlay(`<button class="detail__close" data-act="detail-close">✕ esc</button><h2 class="detail__title">${esc(slug)}</h2><div class="seam"><b>SEAM.</b> No markdown baked for this folder.</div>`, `Plans › ${esc(slug)}`); return true; }
  DocState.slug = slug;
  DocState.file = keys.includes(file) ? file : (keys.find((k) => k.endsWith('/plan.md')) || keys.find((k) => k.endsWith('/README.md')) || keys[0]);
  showOverlay(docReaderHtml(slug, keys, DocState.file), `Plans › ${esc(slug)}`); return true;
}
function closeDetail() {
  const el = $('#detail'); const wasOpen = el.classList.contains('on');
  el.classList.remove('on'); el.hidden = true; $('#viewCrumb').innerHTML = '';
  if (!wasOpen) lastFocus = null; // nothing to restore if it wasn't open
}
// Return focus to whatever opened the dialog. Call AFTER the base view has
// (re)rendered: closing often re-renders #view, detaching the opener node, so fall
// back to its re-rendered twin (same data-id) before giving up.
function restoreOverlayFocus() {
  const t = lastFocus; lastFocus = null;
  if (!t) return;
  if (t.isConnected && typeof t.focus === 'function') { t.focus(); return; }
  const id = t.dataset && t.dataset.id;
  if (id) { const twin = $(`#view [data-id="${CSS.escape(id)}"]`); if (twin) twin.focus(); }
}

/* ============================================================================
 * Router — every entity is a URL; the detail overlay is route-driven.
 * ========================================================================== */
const VIEW_IDS = new Set(VIEWS.map((v) => v.id));
const ENTITY_KINDS = new Set(['issue', 'epic', 'decision', 'work']);
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  return { kind: seg[0] || 'overview', arg: decodeURIComponent(seg.slice(1).join('/')), query: new URLSearchParams(qs || '') };
}
function currentViewTitle() { const v = VIEWS.find((x) => x.id === State.route); return v ? v.title : 'Overview'; }
function renderView(id) {
  const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
  State.route = v.id; State.rendered = v.id;
  $('#viewTitle').textContent = v.title;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v.id));
  const view = $('#view');
  view.classList.toggle('view--flush', !!v.flush);
  view.innerHTML = v.render();
  enhanceA11y(view);
  view.scrollTop = 0;
  afterRender();
}
function route() {
  const { kind, arg, query } = parseHash();
  if (ENTITY_KINDS.has(kind) && arg) {
    if (State.rendered == null) renderView(State.route || 'overview'); // base under the overlay
    let ok = true;
    if (kind === 'issue' || kind === 'epic') ok = showIssue(arg);
    else if (kind === 'decision') ok = showDecision(arg);
    else if (kind === 'work') ok = showWork(arg);
    if (!ok) { closeDetail(); restoreOverlayFocus(); } // unknown entity → just show the base view
    return;
  }
  // view route — closing the overlay re-renders the base view, so restore focus after.
  closeDetail();
  const id = VIEW_IDS.has(kind) ? kind : 'overview';
  if (id === 'board') State.board.epicFocus = query.get('epic') || null; // #/board?epic=:id focuses one epic
  renderView(id);
  restoreOverlayFocus();
}
function afterRender() {
  const bs = $('#boardSearch');
  if (bs) bs.addEventListener('input', (e) => { State.filters.q = e.target.value.trim(); rerender(); });
  const mf = $('#memFilter');
  if (mf) mf.addEventListener('input', (e) => { State.memFilter = e.target.value.trim(); rerender(); });
}
function rerender() {
  const v = VIEWS.find((x) => x.id === State.route) || VIEWS[0];
  const view = $('#view'); const focus = document.activeElement?.id;
  view.innerHTML = v.render(); enhanceA11y(view); afterRender();
  if (focus === 'boardSearch' || focus === 'memFilter') { const el = $('#' + focus); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
}

function buildNav() {
  const wts = State.snapshot.ops?.worktrees || [];
  const counts = {
    board: State.issues.filter((i) => i.type !== 'epic').length, epics: State.epics.length,
    workspaces: wts.filter((w) => !w.archived).length,
    architecture: (State.snapshot.decisions || []).length, plans: (State.snapshot.plans || []).length,
    memory: (State.snapshot.decisions || []).length, ops: (State.snapshot.ops?.activeClaims || []).length,
  };
  $('#nav').innerHTML = `<div class="nav__label">Views</div>` + VIEWS.map((v) =>
    `<a href="#/${v.id}" data-view="${v.id}">${icon(v.id)}<span>${esc(v.title)}</span>${counts[v.id] != null ? `<span class="n">${counts[v.id]}</span>` : ''}</a>`).join('');
}

// Shared action handler for clicks in both #view and the #detail overlay.
function handleAct(t) {
  const act = t.dataset.act;
  if (act === 'open') { const k = t.dataset.kind || 'issue'; location.hash = `#/${k}/${encodeURIComponent(t.dataset.id)}`; }
  else if (act === 'goto') { location.hash = t.dataset.hash; }
  else if (act === 'doc-file') { showWork(t.dataset.slug, t.dataset.file); }
  else if (act === 'clear-focus') { State.board.epicFocus = null; location.hash = '#/board'; if (State.route === 'board') rerender(); }
  else if (act === 'more') { const k = t.dataset.col; State.board.limits[k] = (State.board.limits[k] ?? 30) + 30; rerender(); }
  else if (act === 'chip-type') { const v = t.dataset.val; State.filters.types.has(v) ? State.filters.types.delete(v) : State.filters.types.add(v); rerender(); }
  else if (act === 'chip-prio') { const v = t.dataset.val; State.filters.prios.has(v) ? State.filters.prios.delete(v) : State.filters.prios.add(v); rerender(); }
  else if (act === 'chip-clear') { State.filters.types.clear(); State.filters.prios.clear(); rerender(); }
  else if (act === 'epics-tab') { State.epicsTab = t.dataset.tab; rerender(); }
  else if (act === 'toggle-epic') { const id = t.dataset.id; State.epicsExpanded.has(id) ? State.epicsExpanded.delete(id) : State.epicsExpanded.add(id); rerender(); }
  else if (act === 'ws-arch') { State.wsArchived = t.dataset.v === '1'; rerender(); }
  else if (act === 'board-closed') { State.board.showClosed = !State.board.showClosed; State.board.limits = {}; rerender(); }
  else if (act === 'board-mode') { State.board.mode = t.dataset.mode === 'table' ? 'table' : 'kanban'; try { localStorage.setItem('forge-board-mode', State.board.mode); } catch (_e) { /* private mode */ } rerender(); }
  else if (act === 'toggle-workgroup') { const id = t.dataset.id; State.board.tableCollapsed.has(id) ? State.board.tableCollapsed.delete(id) : State.board.tableCollapsed.add(id); rerender(); }
  else if (act === 'toggle-area') { const id = t.dataset.id; State.archExpanded.has(id) ? State.archExpanded.delete(id) : State.archExpanded.add(id); rerender(); }
}
function onViewClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  handleAct(t);
}
// Give every non-native [data-act] element button semantics so keyboard users can
// reach and activate cards / rows / area-nodes. Called after each innerHTML render.
function enhanceA11y(root) {
  if (!root) return;
  root.querySelectorAll('[data-act]').forEach((el) => {
    if (!needsButtonSemantics(el.tagName)) return; // a / button / input already operable
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  });
}
// Enter / Space activates a focused [data-act] element (native controls handle
// their own keys, so we skip them to avoid double-firing).
function onActKeydown(e) {
  if (!isActivationKey(e.key)) return;
  const t = e.target.closest('[data-act]'); if (!t) return;
  if (!needsButtonSemantics(t.tagName)) return;
  e.preventDefault(); // Space would otherwise scroll
  handleAct(t);
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
      grp('Issues', iss, (i) => `<div class="sr-item" data-nav="issue" data-id="${esc(i.id)}">${isLive(i) ? pulse(true) : `<span class="glyph">${STATUS_GLYPH[columnOf(i)] || '○'}</span>`}<span class="t">${esc(clamp(i.title, 50))}</span></div>`) +
      grp('Epics', eps, (e) => `<div class="sr-item" data-nav="epic" data-id="${esc(e.id)}"><span class="glyph">${HEALTH_GLYPH[epicHealth(e)]}</span><span class="t">${esc(clamp(deEpic(e.title), 48))}</span></div>`) +
      grp('Decisions', dec, (d) => `<div class="sr-item" data-nav="decision" data-id="${esc(String(d.id))}"><span class="tag">${esc(clamp(d.status, 8))}</span><span class="t">${esc(clamp(d.title, 44))}</span></div>`) ||
      `<div class="sr-empty">No matches for “${esc(q)}”.</div>`;
    box.classList.add('on');
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  box.addEventListener('click', (e) => {
    const it = e.target.closest('[data-nav]'); if (!it) return;
    box.classList.remove('on'); input.value = '';
    location.hash = `#/${it.dataset.nav}/${encodeURIComponent(it.dataset.id)}`;
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.classList.remove('on'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !/input|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape') { box.classList.remove('on'); input.blur(); }
  });
}

function wireTheme() {
  const root = document.documentElement;
  const KEY = 'forge-theme-v5';
  // Storage can be unavailable/throwing under file:// or private mode — never let it block boot.
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_err) { /* storage unavailable */ }
  root.setAttribute('data-theme', (saved === 'light' || saved === 'dark') ? saved : 'dark');
  const paint = () => { const dark = root.getAttribute('data-theme') !== 'light'; $('#themeLabel').textContent = dark ? 'Light' : 'Dark'; };
  paint();
  $('#themeToggle').addEventListener('click', () => {
    const dark = root.getAttribute('data-theme') !== 'light';
    const next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (_err) { /* storage unavailable */ }
    paint();
  });
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
  try { const snap = await DataSource.refetch(); rebuild(snap); buildNav(); State.rendered = null; route(); updateStamp(); }
  catch (_err) { if (!silent) { location.reload(); return; } }
  finally { btn.classList.remove('spin'); }
}

async function boot() {
  try {
    const snap = await DataSource.load();
    rebuild(snap);
    try { const m = localStorage.getItem('forge-board-mode'); if (m === 'table' || m === 'kanban') State.board.mode = m; } catch (_e) { /* private mode */ }
    buildNav(); wireTheme(); wireGlobalSearch();
    $('#refreshBtn').addEventListener('click', () => doRefresh(false));
    $('#view').addEventListener('click', onViewClick);
    $('#view').addEventListener('keydown', onActKeydown);
    $('#detail').addEventListener('click', (e) => {
      if (e.target.closest('[data-act="detail-close"]')) { history.length > 1 ? history.back() : (location.hash = '#/' + (State.route || 'overview')); return; }
      const t = e.target.closest('[data-act]'); if (t) handleAct(t);
    });
    $('#detail').addEventListener('keydown', onActKeydown);
    $('#detail').addEventListener('keydown', trapOverlayFocus);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#detail').hidden) { history.length > 1 ? history.back() : (location.hash = '#/' + (State.route || 'overview')); } });
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
  module.exports = { columnOf, matchesFilter, relTime, epicRollup, epicHealth, isLive, lifecyclePhase, wtSummary, renderMarkdown, isActivationKey, needsButtonSemantics, State };
}
