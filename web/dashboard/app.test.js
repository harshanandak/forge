// Tests for the dashboard's pure, DOM-free logic (board derivation, filtering,
// relative time) plus the baked snapshot's integrity. Runs under `bun test`.
import { test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const app = require(join(here, 'app.js'));

test('module exports the pure helpers without touching the DOM', () => {
  expect(typeof app.columnOf).toBe('function');
  expect(typeof app.matchesFilter).toBe('function');
  expect(typeof app.relTime).toBe('function');
  expect(typeof app.epicRollup).toBe('function');
  expect(typeof app.epicHealth).toBe('function');
  expect(typeof app.isLive).toBe('function');
  expect(typeof app.lifecyclePhase).toBe('function');
});

test('isLive flags open + claimed issues (best-effort liveness)', () => {
  expect(app.isLive({ status: 'open', claimed_by: 'forge' })).toBe(true);
  expect(app.isLive({ status: 'open', claimed_by: null })).toBe(false);
  expect(app.isLive({ status: 'done', claimed_by: 'forge' })).toBe(false);
});

test('lifecyclePhase derives phase from real signals; claimed-open is UNKNOWN, not asserted dev', () => {
  // done issue = past ship
  expect(app.lifecyclePhase({ status: 'done' })).toEqual({ idx: 6, label: 'shipped' });
  // cancelled
  expect(app.lifecyclePhase({ status: 'cancelled' })).toEqual({ idx: 0, label: 'cancelled' });
  // claimed + open: exact stage is unknown (no kernel currentStage) — flagged, not "dev"
  const p = app.lifecyclePhase({ status: 'open', claimed_by: 'a' });
  expect(p.idx).toBe(2);
  expect(p.label).toBe('in progress');
  expect(p.unknown).toBe(true);
  // unclaimed open = planned
  expect(app.lifecyclePhase({ status: 'open' })).toEqual({ idx: 1, label: 'planned' });
});

test('epicRollup includes a live count', () => {
  const kids = [{ status: 'open', claimed_by: 'a' }, { status: 'open', claimed_by: 'b' }, { status: 'open' }, { status: 'done' }];
  expect(app.epicRollup({ id: 'e' }, kids).live).toBe(2);
});

test('wtSummary normalizes real git + PR state for the Workspaces view', () => {
  expect(typeof app.wtSummary).toBe('function');
  const w = app.wtSummary({ ahead: 3, behind: 4, dirty: 1, archived: false, pr: { number: 341, ci: 'fail' } });
  expect(w.ahead).toBe(3);
  expect(w.behind).toBe(4);
  expect(w.hasGit).toBe(true);
  expect(w.clean).toBe(false);
  expect(w.pr.number).toBe(341);
  // clean when dirty === 0; SEAM (no git) when counts absent
  expect(app.wtSummary({ dirty: 0 }).clean).toBe(true);
  expect(app.wtSummary({}).hasGit).toBe(false);
  expect(app.wtSummary({ archived: true }).archived).toBe(true);
});

test('epicRollup counts children by state', () => {
  const kids = [
    { status: 'done' }, { status: 'done' },
    { status: 'open', blocked: true }, { status: 'open', claimed_by: 'a' }, { status: 'open' },
  ];
  const r = app.epicRollup({ id: 'e1' }, kids);
  expect(r.total).toBe(5);
  expect(r.done).toBe(2);
  expect(r.blocked).toBe(1);
  expect(r.inprog).toBe(1);
  expect(r.ratio).toBeCloseTo(0.4);
});

test('epicHealth derives on-track / at-risk / off-track / completed', () => {
  expect(app.epicHealth({ status: 'done' }, [])).toBe('done');
  // >=25% blocked → off-track
  expect(app.epicHealth({ status: 'open' }, [{ status: 'open', blocked: true }, { status: 'done' }, { status: 'open' }, { status: 'open' }])).toBe('risk');
  // >=50% done, no blocking → on-track
  expect(app.epicHealth({ status: 'open' }, [{ status: 'done' }, { status: 'done' }, { status: 'open' }])).toBe('ok');
  // some progress but low → at-risk
  expect(app.epicHealth({ status: 'open' }, [{ status: 'done' }, { status: 'open' }, { status: 'open' }, { status: 'open' }, { status: 'open' }])).toBe('warn');
  // childless leaf, not blocked → on-track
  expect(app.epicHealth({ status: 'open' }, [])).toBe('ok');
});

test('columnOf routes each issue to exactly one board column', () => {
  expect(app.columnOf({ status: 'done' })).toBe('done');
  expect(app.columnOf({ status: 'cancelled' })).toBe(null); // excluded
  expect(app.columnOf({ status: 'backlog' })).toBe('backlog'); // real kernel backlog state
  expect(app.columnOf({ status: 'open', blocked: true })).toBe('blocked');
  expect(app.columnOf({ status: 'open', claimed_by: 'agent' })).toBe('progress');
  expect(app.columnOf({ status: 'open' })).toBe('ready');
  // blocked takes precedence over a claim
  expect(app.columnOf({ status: 'open', blocked: true, claimed_by: 'a' })).toBe('blocked');
  // backlog status wins over a blocked flag (parked, not "blocked in Ready")
  expect(app.columnOf({ status: 'backlog', blocked: true })).toBe('backlog');
});

test('matchesFilter: multi-select (OR within a facet, AND across facets) + text query', () => {
  const bug = { title: 'Fix broker conflict', id: 'abc123', type: 'bug', priority: 'P0', claimed_by: 'forge', labels: ['kernel'] };
  const feat = { title: 'Add profile page', id: 'def456', type: 'feature', priority: 'P2', labels: [] };
  const reset = () => (app.State.filters = { q: '', types: new Set(), prios: new Set() });

  reset();
  expect(app.matchesFilter(bug)).toBe(true); // no filters → everything matches

  // single type selected → visible-state facet, only that type passes
  app.State.filters = { q: '', types: new Set(['bug']), prios: new Set() };
  expect(app.matchesFilter(bug)).toBe(true);
  expect(app.matchesFilter(feat)).toBe(false);

  // OR within the type facet: selecting bug AND feature admits both (never empties)
  app.State.filters = { q: '', types: new Set(['bug', 'feature']), prios: new Set() };
  expect(app.matchesFilter(bug)).toBe(true);
  expect(app.matchesFilter(feat)).toBe(true);

  // AND across facets: type∈{bug} AND prio∈{P0}
  app.State.filters = { q: '', types: new Set(['bug']), prios: new Set(['P0']) };
  expect(app.matchesFilter(bug)).toBe(true);
  app.State.filters = { q: '', types: new Set(['bug']), prios: new Set(['P2']) };
  expect(app.matchesFilter(bug)).toBe(false); // right type, wrong priority

  // OR within priority facet
  app.State.filters = { q: '', types: new Set(), prios: new Set(['P0', 'P2']) };
  expect(app.matchesFilter(bug)).toBe(true);
  expect(app.matchesFilter(feat)).toBe(true);

  reset();
  app.State.filters.q = 'broker';
  expect(app.matchesFilter(bug)).toBe(true); // title match
  app.State.filters.q = 'kernel';
  expect(app.matchesFilter(bug)).toBe(true); // label match
  app.State.filters.q = 'nonexistent-xyz';
  expect(app.matchesFilter(bug)).toBe(false);

  reset(); // restore shared state for other tests
});

test('keyboard a11y: Enter/Space activate; native controls keep their own key handling', () => {
  expect(typeof app.isActivationKey).toBe('function');
  expect(typeof app.needsButtonSemantics).toBe('function');
  // Enter and Space (both spellings) activate a focused card/row/area-node.
  expect(app.isActivationKey('Enter')).toBe(true);
  expect(app.isActivationKey(' ')).toBe(true);
  expect(app.isActivationKey('Spacebar')).toBe(true);
  expect(app.isActivationKey('Tab')).toBe(false);
  expect(app.isActivationKey('a')).toBe(false);
  // Non-native elements (div/span/tr) need button semantics + our key handling…
  expect(app.needsButtonSemantics('div')).toBe(true);
  expect(app.needsButtonSemantics('SPAN')).toBe(true);
  expect(app.needsButtonSemantics('tr')).toBe(true);
  // …while natively-operable controls are left alone (browser handles keys/focus).
  expect(app.needsButtonSemantics('a')).toBe(false);
  expect(app.needsButtonSemantics('BUTTON')).toBe(false);
  expect(app.needsButtonSemantics('input')).toBe(false);
  expect(app.needsButtonSemantics(null)).toBe(true); // unknown → treat as non-native
});

test('renderMarkdown converts headings, lists, code and links to safe HTML', () => {
  expect(typeof app.renderMarkdown).toBe('function');
  const html = app.renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n');
  expect(html).toContain('<h1');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('<code>code</code>');
  expect(html).toContain('<li>one</li>');
  // fenced code block preserved and escaped
  const fenced = app.renderMarkdown('```\n<script>x</script>\n```');
  expect(fenced).toContain('<pre><code>');
  expect(fenced).toContain('&lt;script&gt;');
  // raw HTML in prose is escaped, never injected
  expect(app.renderMarkdown('a <img src=x onerror=y> b')).not.toContain('<img');
});

test('relTime produces human-readable deltas', () => {
  const now = Date.now();
  expect(app.relTime(new Date(now - 30 * 1000).toISOString())).toMatch(/^\d+s$/);
  expect(app.relTime(new Date(now - 5 * 60 * 1000).toISOString())).toMatch(/^\d+m$/);
  expect(app.relTime(new Date(now - 3 * 3600 * 1000).toISOString())).toMatch(/^\d+h$/);
  expect(app.relTime('')).toBe('');
});

test('baked snapshot, when generated, is well-formed', () => {
  const path = join(here, 'data.json');
  if (!existsSync(path)) return; // generated artifact; absent on a fresh clone / CI
  const snap = JSON.parse(readFileSync(path, 'utf8'));
  expect(Array.isArray(snap.issues)).toBe(true);
  expect(snap.issues.length).toBeGreaterThan(0);
  expect(typeof snap.generated_at).toBe('string');
  const first = snap.issues[0];
  ['id', 'title', 'type', 'status', 'priority'].forEach((k) => expect(first).toHaveProperty(k));

  // Every non-cancelled issue lands in exactly one column.
  const buckets = { ready: 0, progress: 0, blocked: 0, done: 0, backlog: 0, none: 0 };
  snap.issues.forEach((i) => { const c = app.columnOf(i); buckets[c || 'none']++; });
  const placed = buckets.ready + buckets.progress + buckets.blocked + buckets.done + buckets.backlog;
  const cancelled = snap.issues.filter((i) => i.status === 'cancelled').length;
  expect(placed + cancelled).toBe(snap.issues.length);
});
