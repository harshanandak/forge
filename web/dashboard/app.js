/* Forge Dashboard — read-only render layer.
   Consumes a baked kernel snapshot (window.FORGE_SNAPSHOT). No framework, no build. */

/* ============================================================================
 * DataSource — the LIVE-VIEW SEAM.
 * Today: returns the baked snapshot synchronously wrapped in a promise.
 * LATER (sync rail): swap `load()` to fetch('data.json') and subscribe to the
 * outbox feed via EventSource('/events'), calling onDelta() to patch state.
 * The rest of the app only depends on this interface, so the live upgrade needs
 * no render changes. See docs/work/2026-07-10-forge-dashboard/plan.md.
 * ========================================================================== */
const DataSource = {
  async load() {
    if (window.FORGE_SNAPSHOT) return window.FORGE_SNAPSHOT;
    // Fallback path for when the page is served over HTTP with only data.json.
    const res = await fetch('data.json');
    return res.json();
  },
  // TODO(sync-rail): subscribe(onDelta) { new EventSource('/events')... }
  subscribe() { /* no-op until the sync rail lands */ },
};

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const esc = (s) => (s == null ? '' : String(s));
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

const PRIO_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4'];
const PRIO_VAR = { P0: '--p0', P1: '--p1', P2: '--p2', P3: '--p3', P4: '--p4' };
const TYPE_LABEL = { feature: 'feat', task: 'task', bug: 'bug', epic: 'epic', decision: 'dec', chore: 'chore' };

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = Date.now();
  const s = Math.round((now - d) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  const days = Math.round(h / 24); if (days < 30) return days + 'd ago';
  return d.toISOString().slice(0, 10);
}

/* ---------- global state ---------- */
const State = {
  snapshot: null,
  issues: [],
  filters: { q: '', type: null, prio: null },
  limits: { ready: 12, progress: 12, blocked: 12, done: 10 },
};

/* ---------- board derivation ---------- */
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
    const q = f.q.toLowerCase();
    const hay = (i.title + ' ' + i.id + ' ' + (i.claimed_by || '') + ' ' + (i.labels || []).join(' ')).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/* ---------- renderers ---------- */
function renderStats() {
  const all = State.issues;
  const by = (fn) => all.reduce((a, i) => (a[fn(i)] = (a[fn(i)] || 0) + 1, a), {});
  const st = by((i) => i.status);
  const done = st.done || 0, open = st.open || 0;
  const total = all.length;
  const donePct = total ? Math.round((done / total) * 100) : 0;
  const blocked = all.filter((i) => i.blocked && i.status !== 'done').length;
  const active = all.filter((i) => i.claimed_by && i.status === 'open').length;
  const ready = all.filter((i) => columnOf(i) === 'ready').length;

  const tiles = [
    { n: total, l: 'Total issues', sub: State.snapshot.schema_version || '', hero: true },
    { n: donePct + '%', l: 'Complete', sub: done + ' done', v: '--done' },
    { n: open, l: 'Open', sub: ready + ' ready', v: '--ready' },
    { n: active, l: 'In progress', sub: 'claimed now', v: '--progress' },
    { n: blocked, l: 'Blocked', sub: 'need unblocking', v: '--blocked' },
  ];
  const wrap = $('#stats'); wrap.innerHTML = '';
  tiles.forEach((t, idx) => {
    const s = el('div', 'stat' + (t.hero ? ' stat--hero' : ''));
    if (t.v) s.style.setProperty('--accar', `var(${t.v})`);
    s.style.animation = `rise .4s ${idx * 0.04}s both`;
    s.append(el('div', 'stat__num', t.n), el('div', 'stat__label', t.l), el('div', 'stat__sub', t.sub));
    wrap.append(s);
  });
  $('#healthCount').textContent = `${total} issues · snapshot`;
}

function renderMeters() {
  const all = State.issues;
  const prio = {}; PRIO_ORDER.forEach((p) => (prio[p] = 0));
  all.forEach((i) => { if (prio[i.priority] != null) prio[i.priority]++; });
  const total = all.length || 1;
  const bar = $('#prioBar'); bar.innerHTML = '';
  const legend = $('#prioLegend'); legend.innerHTML = '';
  PRIO_ORDER.forEach((p) => {
    const seg = el('span'); seg.style.width = (prio[p] / total) * 100 + '%';
    seg.style.background = `var(${PRIO_VAR[p]})`; seg.title = `${p}: ${prio[p]}`;
    bar.append(seg);
    const item = el('div', 'item');
    const sw = el('span', 'swatch'); sw.style.background = `var(${PRIO_VAR[p]})`;
    item.append(sw, document.createTextNode(p + ' '), Object.assign(el('b'), { textContent: prio[p] }));
    legend.append(item);
  });

  const types = {}; all.forEach((i) => (types[i.type] = (types[i.type] || 0) + 1));
  const chips = $('#typeChips'); chips.innerHTML = '';
  Object.entries(types).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    if (t === 'zzzbogus') return;
    const c = el('div', 'typechip');
    c.append(document.createTextNode((TYPE_LABEL[t] || t) + ' '), Object.assign(el('b'), { textContent: n }));
    chips.append(c);
  });
}

function card(i) {
  const c = el('div', 'card');
  c.style.setProperty('--prio', `var(${PRIO_VAR[i.priority] || '--border'})`);
  const top = el('div', 'card__top');
  const tb = el('span', 'badge badge--type', TYPE_LABEL[i.type] || i.type);
  const pb = el('span', 'badge badge--prio', i.priority || '—');
  pb.style.background = `var(${PRIO_VAR[i.priority] || '--faint'})`;
  const id = el('span', 'card__id', String(i.id).slice(0, 8));
  top.append(tb, pb, id);
  c.append(top, el('div', 'card__title', clamp(i.title, 120)));

  const meta = el('div', 'card__meta');
  if (i.claimed_by) {
    const o = el('span', 'card__owner');
    const av = el('span', 'av', i.claimed_by.slice(0, 2));
    o.append(av, document.createTextNode(i.claimed_by));
    meta.append(o);
  }
  (i.labels || []).slice(0, 2).forEach((l) => meta.append(el('span', 'chip', l)));
  if (i.dependencies && i.dependencies.length) meta.append(el('span', 'chip', `${i.dependencies.length} dep`));
  if (meta.childNodes.length) c.append(meta);
  return c;
}

const COLS = [
  { key: 'ready', title: 'Ready', v: '--ready' },
  { key: 'progress', title: 'In progress', v: '--progress' },
  { key: 'blocked', title: 'Blocked', v: '--blocked' },
  { key: 'done', title: 'Done', v: '--done' },
];

function renderBoard() {
  const buckets = { ready: [], progress: [], blocked: [], done: [] };
  State.issues.forEach((i) => {
    if (!matchesFilter(i)) return;
    const col = columnOf(i); if (col) buckets[col].push(i);
  });
  buckets.done.sort((a, b) => new Date(b.closed_at || b.updated_at) - new Date(a.closed_at || a.updated_at));
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  ['ready', 'progress', 'blocked'].forEach((k) =>
    buckets[k].sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || new Date(b.updated_at) - new Date(a.updated_at)));

  const host = $('#boardCols'); host.innerHTML = '';
  let shown = 0;
  COLS.forEach(({ key, title, v }) => {
    const col = el('div', 'col');
    const head = el('div', 'col__head');
    const dot = el('span', 'col__dot'); dot.style.background = `var(${v})`;
    head.append(dot, el('span', 'col__title', title));
    head.append(Object.assign(el('span', 'col__count'), { textContent: buckets[key].length }));
    col.append(head);
    const list = el('div', 'col__list');
    const lim = State.limits[key];
    const items = buckets[key];
    if (!items.length) list.append(el('div', 'empty', 'Nothing here.'));
    items.slice(0, lim).forEach((i, idx) => { const c = card(i); c.style.animationDelay = (idx * 0.015) + 's'; list.append(c); shown++; });
    if (items.length > lim) {
      const btn = el('button', 'more', `Show ${Math.min(20, items.length - lim)} more (${items.length - lim} hidden)`);
      btn.onclick = () => { State.limits[key] += 20; renderBoard(); };
      list.append(btn);
    }
    col.append(list);
    host.append(col);
  });
  $('#boardCount').textContent = `${shown} shown · ${State.issues.filter(matchesFilter).length} match`;
}

function renderFilters() {
  const types = [...new Set(State.issues.map((i) => i.type))].filter((t) => t && t !== 'zzzbogus');
  const tf = $('#typeFilters'); tf.innerHTML = '';
  types.forEach((t) => {
    const b = el('button', '', TYPE_LABEL[t] || t);
    b.onclick = () => { State.filters.type = State.filters.type === t ? null : t; syncFilterUI(); renderBoard(); };
    b.dataset.type = t; tf.append(b);
  });
  const pf = $('#prioFilters'); pf.innerHTML = '';
  PRIO_ORDER.forEach((p) => {
    const b = el('button', '', p);
    b.onclick = () => { State.filters.prio = State.filters.prio === p ? null : p; syncFilterUI(); renderBoard(); };
    b.dataset.prio = p; pf.append(b);
  });
}
function syncFilterUI() {
  document.querySelectorAll('#typeFilters button').forEach((b) => b.classList.toggle('on', b.dataset.type === State.filters.type));
  document.querySelectorAll('#prioFilters button').forEach((b) => b.classList.toggle('on', b.dataset.prio === State.filters.prio));
}

function renderEpics() {
  const kids = {};
  State.issues.forEach((i) => { if (i.parent_id) (kids[i.parent_id] = kids[i.parent_id] || []).push(i); });
  const epics = State.issues.filter((i) => i.type === 'epic')
    .sort((a, b) => (a.status === 'done') - (b.status === 'done') || new Date(b.updated_at) - new Date(a.updated_at));
  $('#epicCount').textContent = `${epics.length}`;
  const grid = $('#epicGrid'); grid.innerHTML = '';
  epics.forEach((e) => {
    const box = el('div', 'epic');
    const top = el('div', 'epic__top');
    const pb = el('span', 'badge badge--prio', e.priority || '—');
    pb.style.background = `var(${PRIO_VAR[e.priority] || '--faint'})`;
    top.append(pb, el('span', 'badge badge--type', e.status));
    box.append(top, el('div', 'epic__title', clamp(e.title.replace(/^\[?EPIC\]?:?\s*/i, ''), 90)));
    const ch = kids[e.id] || [];
    if (ch.length) {
      const done = ch.filter((c) => c.status === 'done').length;
      const roll = el('div', 'epic__roll');
      const pg = el('div', 'epic__prog'); const span = el('span'); span.style.width = (done / ch.length * 100) + '%'; pg.append(span);
      roll.append(pg, el('span', 'epic__rolltext', `${done}/${ch.length}`));
      box.append(roll);
    } else {
      box.append(el('div', 'epic__rolltext', 'no linked children'));
    }
    grid.append(box);
  });
}

function renderDecisions() {
  const decs = State.issues.filter((i) => i.type === 'decision')
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  $('#decCount').textContent = `${decs.length}`;
  const grid = $('#decGrid'); grid.innerHTML = '';
  if (!decs.length) { grid.append(el('div', 'empty', 'No decision records in this snapshot.')); return; }
  decs.forEach((d) => {
    const box = el('div', 'decision');
    const top = el('div', 'decision__top');
    top.append(el('span', 'badge badge--type', 'decision'), el('span', 'badge badge--type', d.status));
    box.append(top, el('div', 'decision__title', d.title));
    const body = (d.body || '').replace(/^#+\s.*$/gm, '').replace(/\n{2,}/g, '\n').trim();
    box.append(el('div', 'decision__body', clamp(body, 340)));
    box.append(el('div', 'decision__id', String(d.id)));
    grid.append(box);
  });
}

function renderActivity() {
  const recent = State.issues.slice()
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 14);
  const tl = $('#timeline'); tl.innerHTML = '';
  const stColor = { done: '--done', open: '--ready', cancelled: '--faint' };
  recent.forEach((i) => {
    const row = el('div', 'tl');
    row.style.setProperty('--st', `var(${(i.blocked ? '--blocked' : stColor[i.status]) || '--faint'})`);
    row.append(el('span', 'tl__time', relTime(i.updated_at)));
    const t = el('span', 'tl__title');
    const b = el('span', 'badge badge--type', TYPE_LABEL[i.type] || i.type);
    t.append(b, document.createTextNode(clamp(i.title, 74)));
    row.append(t);
    tl.append(row);
  });

  const mem = Array.isArray(State.snapshot.memory) ? State.snapshot.memory : [];
  const mp = $('#memPanel'); mp.innerHTML = '';
  if (mem.length) {
    mp.classList.remove('mempanel'); mp.className = 'timeline';
    mem.slice(0, 12).forEach((m) => {
      const row = el('div', 'tl');
      row.append(el('span', 'tl__time', relTime(m.created_at || m.updated_at)));
      row.append(el('span', 'tl__title', clamp(m.text || m.content || m.title || JSON.stringify(m), 80)));
      mp.append(row);
    });
  } else {
    mp.innerHTML = `
      <div class="mp-ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="30" height="30">
          <path d="M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1 0 8v1a4 4 0 0 1-8 0v-1a4 4 0 0 1 0-8V7a4 4 0 0 1 4-4Z"/>
        </svg></div>
      <h4>Kernel memory is empty</h4>
      <p><code>forge recall</code> returned no entries yet. Recalled facts will
      stream here as the kernel records them.</p>`;
  }
}

function renderFooter() {
  const s = State.snapshot;
  $('#footer').innerHTML =
    `snapshot ${esc(s.generated_at)} · ${State.issues.length} issues · source: ${esc(s.source || 'forge --json')}` +
    `<div class="live-todo">LIVE-VIEW SEAM · This is a baked read-only snapshot. ` +
    `The sync-rail outbox feed will later push real-time deltas through <code>DataSource</code> ` +
    `(fetch data.json + EventSource /events) with no render changes. See plan.md.</div>`;
}

function renderSnapMeta() {
  const s = State.snapshot;
  const when = s.generated_at ? new Date(s.generated_at) : new Date();
  $('#snapmeta').innerHTML =
    `<b>snapshot</b><br>${when.toISOString().slice(0, 16).replace('T', ' ')} UTC<br>` +
    `<b>${State.issues.length}</b> issues · read-only`;
  $('#brandTag').textContent = (s.status?.context?.branch) ? 'branch ' + s.status.context.branch : 'kernel dashboard';
}

/* ---------- interactions ---------- */
function wireSearch() {
  let t;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      State.filters.q = e.target.value.trim();
      State.limits = { ready: 12, progress: 12, blocked: 12, done: 10 };
      renderBoard();
    }, 120);
  });
}

function wireTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem('forge-theme');
  if (saved) root.setAttribute('data-theme', saved);
  const paint = () => {
    const dark = root.getAttribute('data-theme') !== 'light';
    $('#themeLabel').textContent = dark ? 'Light' : 'Dark';
    $('#themeIcon').textContent = dark ? '◐' : '◑';
  };
  paint();
  $('#themeToggle').addEventListener('click', () => {
    const dark = root.getAttribute('data-theme') !== 'light';
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
    localStorage.setItem('forge-theme', dark ? 'light' : 'dark');
    paint();
  });
}

function wireScrollSpy() {
  const links = [...document.querySelectorAll('#nav a')];
  const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        links.forEach((l) => l.classList.remove('active'));
        map.get(en.target.id)?.classList.add('active');
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  ['health', 'board', 'epics', 'decisions', 'activity'].forEach((id) => {
    const s = document.getElementById(id); if (s) obs.observe(s);
  });
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const snap = await DataSource.load();
    State.snapshot = snap;
    State.issues = (snap.issues || []).filter((i) => i && i.type !== 'zzzbogus');
    renderSnapMeta();
    renderStats();
    renderMeters();
    renderFilters();
    renderBoard();
    renderEpics();
    renderDecisions();
    renderActivity();
    renderFooter();
    wireSearch();
    wireTheme();
    wireScrollSpy();
  } catch (err) {
    document.querySelector('.main').innerHTML =
      `<div style="padding:40px;color:var(--muted)"><h2>Could not load snapshot</h2>
       <p>${esc(err.message)}</p><p>Run <code>node web/dashboard/generate-snapshot.mjs</code> to bake it.</p></div>`;
  }
}

// Run in the browser; stay inert (and unit-testable) under Node/Bun.
if (typeof document !== 'undefined') boot();

// Export the pure, DOM-free logic for tests (see app.test.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { columnOf, matchesFilter, relTime, State };
}
