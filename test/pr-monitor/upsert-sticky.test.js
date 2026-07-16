'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  upsertStickyComment,
  markerCommentIds,
  sortIdsAscending,
  isAlreadyGone,
  ghStickyClient,
} = require('../../lib/pr-monitor/upsert-sticky');

const MARKER = '<!-- forge-pr-monitor -->';

// An in-memory GitHub comments store. `listQueue`, when provided, lets a test
// script successive list() results to simulate a comment appearing between the
// first list and the post-create re-list (the concurrent-burst race).
function makeClient({ initial = [], listQueue = null, createId = null } = {}) {
  const store = new Map(initial.map((comment) => [comment.id, { ...comment }]));
  let nextId = (initial.reduce((max, comment) => Math.max(max, Number(comment.id)), 100)) + 1;
  const calls = { create: 0, update: [], remove: [] };
  let listCall = 0;

  return {
    store,
    calls,
    async list() {
      listCall += 1;
      if (listQueue && listQueue[listCall - 1]) {
        // Materialize the scripted snapshot into the store so later deletes/updates hit it.
        for (const comment of listQueue[listCall - 1]) {
          if (!store.has(comment.id)) {
            store.set(comment.id, { ...comment });
          }
        }
        return listQueue[listCall - 1].map((comment) => ({ ...store.get(comment.id) }));
      }
      return [...store.values()].map((comment) => ({ ...comment }));
    },
    async create() {
      calls.create += 1;
      const id = createId !== null ? createId : nextId++;
      store.set(id, { id, body: `${MARKER}\nfresh` });
    },
    async update(id) {
      calls.update.push(id);
      const existing = store.get(id);
      if (existing) {
        existing.body = `${MARKER}\nupdated`;
      }
    },
    async remove(id) {
      calls.remove.push(id);
      store.delete(id);
    },
  };
}

function markerCount(client) {
  return [...client.store.values()].filter((comment) => comment.body.includes(MARKER)).length;
}

describe('pr-monitor upsert-sticky reconcile-to-one', () => {
  test('creates exactly one sticky when the PR has none', async () => {
    const client = makeClient({ initial: [] });

    const result = await upsertStickyComment({ marker: MARKER }, client);

    expect(client.calls.create).toBe(1);
    expect(markerCount(client)).toBe(1);
    expect(result.deleted).toEqual([]);
  });

  test('updates the single existing sticky in place (no create, no delete)', async () => {
    const client = makeClient({ initial: [{ id: 100, body: `${MARKER}\nold` }] });

    const result = await upsertStickyComment({ marker: MARKER }, client);

    expect(client.calls.create).toBe(0);
    expect(client.calls.update).toEqual([100]);
    expect(client.calls.remove).toEqual([]);
    expect(markerCount(client)).toBe(1);
    expect(result.survivor).toBe(100);
  });

  test('a comment that appears between list and create collapses to exactly one', async () => {
    // First list: empty → this run creates. Re-list: TWO markers exist (a
    // concurrent run created id 205 while this run created id 206). The run must
    // keep the deterministic lowest-id survivor and delete the rest.
    const client = makeClient({
      createId: 206, // this run's own create
      listQueue: [
        [], // initial list — nothing yet
        [
          { id: 205, body: `${MARKER}\npeer` }, // peer created concurrently
          { id: 206, body: `${MARKER}\nfresh` }, // this run's create, now visible
        ], // re-list after create — both present
      ],
    });

    const result = await upsertStickyComment({ marker: MARKER }, client);

    expect(client.calls.create).toBe(1);
    expect(result.survivor).toBe(205); // lowest id wins deterministically
    expect(client.calls.update).toEqual([205]);
    expect(client.calls.remove).toEqual([206]);
    expect(markerCount(client)).toBe(1);
  });

  test('collapses multiple pre-existing stickies to one (self-heal)', async () => {
    const client = makeClient({
      initial: [
        { id: 300, body: `${MARKER}\na` },
        { id: 301, body: `${MARKER}\nb` },
        { id: 302, body: `${MARKER}\nc` },
      ],
    });

    const result = await upsertStickyComment({ marker: MARKER }, client);

    expect(client.calls.create).toBe(0);
    expect(result.survivor).toBe(300);
    expect(client.calls.remove.sort()).toEqual([301, 302]);
    expect(markerCount(client)).toBe(1);
  });

  test('ignores non-marker comments when reconciling', async () => {
    const client = makeClient({
      initial: [
        { id: 400, body: 'a normal human comment' },
        { id: 401, body: `${MARKER}\nsticky` },
      ],
    });

    await upsertStickyComment({ marker: MARKER }, client);

    expect(client.calls.remove).toEqual([]);
    expect(client.store.has(400)).toBe(true);
    expect(markerCount(client)).toBe(1);
  });

  test('markerCommentIds + sortIdsAscending select the oldest marker id', () => {
    const ids = markerCommentIds(
      [
        { id: 9, body: 'nope' },
        { id: 12, body: `x ${MARKER} y` },
        { id: 7, body: `${MARKER}` },
      ],
      MARKER,
    );
    expect(sortIdsAscending(ids)).toEqual([7, 12]);
  });
});

describe('pr-monitor sticky client error tolerance (only already-gone is benign)', () => {
  // A gh error mimicking execFileSync's shape: non-zero exit + stderr text.
  function ghError(stderr) {
    const err = new Error('Command failed: gh api');
    err.stderr = stderr;
    return err;
  }

  test('isAlreadyGone classifies 404/410 as benign, real errors as not', () => {
    expect(isAlreadyGone(ghError('gh: Not Found (HTTP 404)'))).toBe(true);
    expect(isAlreadyGone(ghError('HTTP 410: Gone'))).toBe(true);
    // Auth failures, rate limits, and generic errors must NOT be swallowed.
    expect(isAlreadyGone(ghError('gh: Bad credentials (HTTP 401)'))).toBe(false);
    expect(isAlreadyGone(ghError('HTTP 403: rate limit exceeded'))).toBe(false);
    expect(isAlreadyGone(ghError('HTTP 500: server error'))).toBe(false);
    expect(isAlreadyGone(new Error('socket hang up'))).toBe(false);
  });

  test('remove() swallows an already-gone 404 but rethrows a real error', async () => {
    const gone = ghStickyClient({
      repo: 'o/r',
      pr: '1',
      run: () => { throw ghError('gh: Not Found (HTTP 404)'); },
    });
    await expect(gone.remove(9)).resolves.toBeUndefined();

    const auth = ghStickyClient({
      repo: 'o/r',
      pr: '1',
      run: () => { throw ghError('gh: Bad credentials (HTTP 401)'); },
    });
    let caught;
    try { await auth.remove(9); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(String(caught.stderr)).toContain('401');
  });

  test('update() tolerates a 404 (peer won the survivor) but rethrows a real error', async () => {
    const gone = ghStickyClient({
      repo: 'o/r',
      pr: '1',
      payloadFile: 'p.json',
      run: () => { throw ghError('HTTP 404: Not Found'); },
    });
    await expect(gone.update(9)).resolves.toBeUndefined();

    const rate = ghStickyClient({
      repo: 'o/r',
      pr: '1',
      payloadFile: 'p.json',
      run: () => { throw ghError('HTTP 403: rate limit exceeded'); },
    });
    let caught;
    try { await rate.update(9); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(String(caught.stderr)).toContain('403');
  });
});

describe('pr-monitor workflow has no concurrency group', () => {
  test('pr-monitor.yml declares no concurrency block (avoids GitHub run cancellations)', () => {
    const yml = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '.github', 'workflows', 'pr-monitor.yml'),
      'utf8',
    );
    const doc = yaml.load(yml);
    // A `concurrency:` group would leave a trail of CANCELLED runs (red checks);
    // the race it used to guard is now handled by upsert reconcile-to-one. Assert
    // on the PARSED workflow, not raw text, so the top-of-file comment explaining
    // the absence (which mentions the words) doesn't produce a false match.
    expect(Object.prototype.hasOwnProperty.call(doc, 'concurrency')).toBe(false);
    // The race-safe upsert must actually be wired into a run step.
    const steps = doc.jobs.monitor.steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(steps.some((run) => run.includes('lib/pr-monitor/upsert-sticky.js'))).toBe(true);
  });

  test('the sticky-upsert step is best-effort (continue-on-error) so a transient gh failure is not a red check', () => {
    const doc = yaml.load(fs.readFileSync(
      path.resolve(__dirname, '..', '..', '.github', 'workflows', 'pr-monitor.yml'),
      'utf8',
    ));
    const upsertStep = doc.jobs.monitor.steps.find(
      (step) => typeof step.run === 'string' && step.run.includes('lib/pr-monitor/upsert-sticky.js'),
    );
    expect(upsertStep).toBeDefined();
    expect(upsertStep['continue-on-error']).toBe(true);
  });
});
