'use strict';

const { describe, expect, test } = require('bun:test');
const zlib = require('node:zlib');

const { runFlowMonitorPass } = require('../../lib/pr-monitor/flow-monitor');
const { computeContentHash } = require('../../packages/memory-contracts');

function snapshot(overrides = {}) {
  return {
    repo: 'owner/forge',
    pr: '42',
    headSha: 'a'.repeat(40),
    state: 'OPEN',
    checks: [],
    threads: [],
    reviews: [],
    comments: [],
    verdict: { state: 'BLOCKED-CHECKS', reason: 'pending' },
    ...overrides,
  };
}

function durableStore() {
  const events = [];
  const cursors = new Map();
  const terminalReceipts = new Map();
  let outboxOverflow = false;
  return {
    events,
    setCursor(target, sequence, monitorId = 'pr:owner/forge:42') {
      if (!cursors.has(monitorId)) cursors.set(monitorId, new Map());
      cursors.get(monitorId).set(target, sequence);
    },
    setOutboxOverflow(value) { outboxOverflow = value; },
    get terminalReceipt() { return terminalReceipts.values().next().value || null; },
    async appendEvent(event, targets) {
      const existing = events.find((item) => item.payload.monitor_id === event.payload.monitor_id
        && (item.payload.event_id === event.payload.event_id
          || item.payload.sequence === event.payload.sequence));
      if (existing) {
        if (existing.content_hash !== event.content_hash) {
          const error = new Error('identity conflict');
          error.code = 'MONITOR_EVENT_CONFLICT';
          throw error;
        }
        return { idempotent: true };
      }
      events.push(structuredClone(event));
      return { idempotent: false, targets };
    },
    async getEvent(eventId) {
      const event = events.find(item => item.payload.event_id === eventId);
      return event ? { envelope_json: JSON.stringify(event) } : null;
    },
    async readEventTail(monitorId, { limit }) {
      const matching = events.filter(event => event.payload.monitor_id === monitorId);
      const selected = matching.slice(-limit);
      return {
        events: selected.map(event => ({
          event_id: event.payload.event_id,
          monitor_id: event.payload.monitor_id,
          sequence: event.payload.sequence,
          content_hash: event.content_hash,
          envelope_json: JSON.stringify(event),
        })),
        overflow: matching.length > limit,
        truncated_before_sequence: matching.length > limit ? selected[0].payload.sequence : null,
      };
    },
    async readDeliveryState(monitorId) {
      return {
        cursors: [...(cursors.get(monitorId) || new Map()).entries()]
          .map(([target, sequence]) => ({ monitor_id: monitorId, target, sequence })),
        outbox: [],
        terminal_receipt: terminalReceipts.get(monitorId) ? {
          monitor_id: monitorId,
          content_hash: terminalReceipts.get(monitorId).content_hash,
          envelope_json: JSON.stringify(terminalReceipts.get(monitorId)),
        } : null,
        overflow: { cursors: false, outbox: outboxOverflow },
      };
    },
    async recordDeliveryReceipt(receipt) {
      const event = events.find(item => item.payload.event_id === receipt.payload.event_id);
      if (!cursors.has(event.payload.monitor_id)) cursors.set(event.payload.monitor_id, new Map());
      cursors.get(event.payload.monitor_id).set(receipt.payload.target, event.payload.sequence);
      return { idempotent: false };
    },
    async recordTerminalReceipt(receipt) {
      const prior = terminalReceipts.get(receipt.payload.monitor_id);
      if (prior && prior.content_hash !== receipt.content_hash) {
        throw new Error('monitor receipt conflict');
      }
      terminalReceipts.set(receipt.payload.monitor_id, structuredClone(receipt));
      return { idempotent: Boolean(prior) };
    },
  };
}

function context(store, gather, deliverLegacy) {
  return {
    monitorId: 'pr:owner/forge:42',
    ownerRunId: 'run-42',
    packetId: 'packet-42',
    subjectId: 'owner/forge#42',
    store,
    gather,
    deliverLegacy,
    now: () => '2026-08-12T12:00:00.000Z',
  };
}

async function seedHistory(store, count) {
  await runFlowMonitorPass(context(store, async () => snapshot(), async () => {}));
  const template = store.events[0];
  for (let sequence = 2; sequence <= count; sequence += 1) {
    const event = structuredClone(template);
    event.object_id = `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
    event.payload.event_id = sequence.toString(16).padStart(64, '0');
    event.payload.sequence = sequence;
    event.payload.bounded_payload.record.seq = sequence;
    event.payload.bounded_payload.snapshot.headSha = sequence.toString(16).padStart(40, '0');
    event.content_hash = computeContentHash(event);
    store.events.push(event);
  }
  store.setCursor('legacy-journal', count);
}

describe('Flow-backed PR monitor authority', () => {
  test('persists through public Memory before legacy journal delivery and ignores legacy snapshot authority', async () => {
    const store = durableStore();
    const order = [];
    const next = snapshot();
    const result = await runFlowMonitorPass(context(
      store,
      async () => next,
      async record => {
        expect(store.events.some(event => event.payload.sequence === record.seq)).toBe(true);
        order.push(`legacy:${record.seq}`);
      },
    ));

    expect(result.events).toHaveLength(1);
    expect(store.events).toHaveLength(1);
    expect(order).toEqual(['legacy:1']);
    expect(result.authority).toBe('memory');
  });

  test('reconstructs the prior snapshot from durable events after restart and emits no duplicate', async () => {
    const store = durableStore();
    const next = snapshot();
    const delivered = [];
    await runFlowMonitorPass(context(store, async () => next, async record => delivered.push(record)));

    const restarted = await runFlowMonitorPass(context(
      store,
      async () => structuredClone(next),
      async record => delivered.push(record),
    ));

    expect(restarted.events).toEqual([]);
    expect(store.events).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  test('normalizes a legacy raw snapshot before comparing compact transition identities', async () => {
    const store = durableStore();
    const current = snapshot({
      checks: [{ name: 'Windows / test', class: 'failed' }],
      reviews: [{ author: 'coderabbitai', state: 'COMMENTED', commitOid: 'a'.repeat(40), submittedAt: 't1' }],
    });
    const delivered = [];
    await runFlowMonitorPass(context(store, async () => current, async record => delivered.push(record)));

    const event = store.events.at(-1);
    event.payload.bounded_payload.snapshot = structuredClone(current);
    event.content_hash = computeContentHash(event);
    const before = delivered.length;

    const restarted = await runFlowMonitorPass(context(
      store, async () => structuredClone(current), async record => delivered.push(record),
    ));

    expect(restarted.events.map(record => record.type)).not.toContain('check.failed');
    expect(restarted.events.map(record => record.type)).not.toContain('review.submitted');
    expect(delivered).toHaveLength(before);
  });

  test('does not checkpoint when only the gzip representation of snapshot evidence changes', async () => {
    const store = durableStore();
    const current = snapshot({ checks: [{ name: 'ci', class: 'green' }] });
    await runFlowMonitorPass(context(store, async () => current, async () => {}));
    const before = store.events.length;
    const event = store.events.at(-1);
    const evidence = zlib.gunzipSync(Buffer.from(
      event.payload.bounded_payload.snapshot._snapshotEvidence, 'base64url',
    ));
    event.payload.bounded_payload.snapshot._snapshotEvidence = zlib.gzipSync(evidence, { level: 1 }).toString('base64url');
    event.content_hash = computeContentHash(event);

    const restarted = await runFlowMonitorPass(context(store, async () => current, async () => {}));

    expect(restarted.events).toEqual([]);
    expect(store.events).toHaveLength(before);
  });

  test('fails closed without writing legacy compatibility state when Memory is unavailable', async () => {
    const store = durableStore();
    store.appendEvent = async () => {
      const error = new Error('provider unavailable');
      error.code = 'MONITOR_UNAVAILABLE';
      throw error;
    };
    let deliveries = 0;

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => { deliveries += 1; })))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(deliveries).toBe(0);
  });

  test('recovers the remaining transition records after a mid-batch append failure', async () => {
    const store = durableStore();
    const appendEvent = store.appendEvent.bind(store);
    let appends = 0;
    store.appendEvent = async (...args) => {
      appends += 1;
      if (appends === 2) throw new Error('mid-batch storage failure');
      return appendEvent(...args);
    };
    const delivered = [];
    const merged = snapshot({ prState: 'MERGED' });
    const ctx = context(store, async () => merged, async record => delivered.push(record));

    await expect(runFlowMonitorPass(ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(store.events.map(event => event.payload.type)).toEqual(['verdict.changed']);
    expect(store.events[0].payload.bounded_payload.snapshot).toBeNull();

    store.appendEvent = appendEvent;
    ctx.gather = async () => { throw new Error('pending recovery must precede changed provider state'); };
    const resumed = await runFlowMonitorPass(ctx);

    expect(resumed.events.map(event => event.type)).toEqual(['pr.merged']);
    expect(delivered.map(event => event.type)).toEqual(['verdict.changed', 'pr.merged']);
    expect(resumed.terminalReceiptId).toBeString();
  });

  test('recovers an accepted transition batch larger than the retained history tail', async () => {
    const store = durableStore();
    const checks = Array.from({ length: 130 }, (_, index) => ({ name: `check-${index}`, class: 'green' }));
    let next = snapshot({ checks });
    const ctx = context(store, async () => next, async () => {});
    await runFlowMonitorPass(ctx);

    next = snapshot({ checks: checks.map(check => ({ ...check, class: 'failed' })) });
    const appendEvent = store.appendEvent;
    let appends = 0;
    store.appendEvent = async (...args) => {
      appends += 1;
      if (appends === 2) throw new Error('mid-batch storage failure');
      return appendEvent(...args);
    };

    await expect(runFlowMonitorPass(ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    store.appendEvent = appendEvent;
    ctx.gather = async () => { throw new Error('accepted batch recovery must precede provider state'); };

    const resumed = await runFlowMonitorPass(ctx);

    expect(resumed.events).toHaveLength(129);
    expect(store.events.at(-1).payload.bounded_payload.checkpoint_complete).toBe(true);
  });

  test('recovers a high-entropy transition whose recovery evidence requires multiple bounded manifests', async () => {
    const store = durableStore();
    const checks = Array.from({ length: 128 }, (_, index) => ({
      name: Array.from({ length: 4 }, (_value, salt) => computeContentHash({ index, salt })).join(''),
      class: 'green',
    }));
    let next = snapshot({ checks });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);

    next = snapshot({ checks: checks.map(check => ({ ...check, class: 'failed' })) });
    const appendEvent = store.appendEvent.bind(store);
    let checkAppends = 0;
    store.appendEvent = async (...args) => {
      if (args[0].payload.type === 'check.failed') {
        checkAppends += 1;
        if (checkAppends === 2) throw new Error('mid-transition storage failure');
      }
      return appendEvent(...args);
    };

    await expect(runFlowMonitorPass(ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const acceptedEvents = structuredClone(store.events);
    store.appendEvent = appendEvent;
    ctx.gather = async () => { throw new Error('accepted transition recovery must precede provider state'); };

    const resumed = await runFlowMonitorPass(ctx);
    const manifests = store.events
      .map(event => event.payload.bounded_payload.pending_batch)
      .filter(Boolean);

    expect(resumed.events).toHaveLength(127);
    expect(delivered.filter(event => event.type === 'check.failed')).toHaveLength(128);
    expect(Math.max(...manifests.map(value => value.length))).toBeLessThanOrEqual(12_000);
    expect(store.events.at(-1).payload.bounded_payload.checkpoint_complete).toBe(true);

    const segmentEvents = store.events.filter(event => Number.isSafeInteger(
      event.payload.bounded_payload.batch_plan?.index,
    ));
    const marker = store.events.find(event => event.payload.bounded_payload.batch_plan?.committed === true);
    const actualEvents = store.events.filter(event => event.payload.type === 'check.failed');
    const decodedSegments = segmentEvents.map(event => JSON.parse(zlib.gunzipSync(Buffer.from(
      event.payload.bounded_payload.pending_batch,
      'base64url',
    ))));
    expect(segmentEvents.length).toBeGreaterThan(1);
    expect(segmentEvents.map(event => event.payload.bounded_payload.batch_plan.index))
      .toEqual(segmentEvents.map((_event, index) => index));
    expect(marker.payload.sequence).toBe(segmentEvents.at(-1).payload.sequence + 1);
    expect(actualEvents[0].payload.sequence).toBe(marker.payload.sequence + 1);
    expect(actualEvents.map(event => event.payload.sequence))
      .toEqual(actualEvents.map((_event, index) => actualEvents[0].payload.sequence + index));
    let boundary = 0;
    for (const [segmentIndex, decoded] of decodedSegments.entries()) {
      for (const event of actualEvents.slice(boundary, boundary + decoded.records.length)) {
        expect(event.payload.bounded_payload.batch_plan.segment_index).toBe(segmentIndex);
      }
      boundary += decoded.records.length;
    }
    expect(boundary).toBe(actualEvents.length);
    expect(JSON.stringify(segmentEvents)).not.toContain(checks[0].name);

    const tamperCases = [
      (events) => {
        const segment = events.find(event => Number.isSafeInteger(event.payload.bounded_payload.batch_plan?.index));
        segment.payload.bounded_payload.batch_plan.index += 1;
        segment.content_hash = computeContentHash(segment);
      },
      (events) => {
        const segment = events.find(event => event.payload.bounded_payload.pending_batch);
        const value = segment.payload.bounded_payload.pending_batch;
        segment.payload.bounded_payload.pending_batch = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
        segment.content_hash = computeContentHash(segment);
      },
      (events) => {
        const actual = events.find(event => event.payload.type === 'check.failed');
        actual.payload.bounded_payload.batch_plan.id = '0'.repeat(64);
        actual.content_hash = computeContentHash(actual);
      },
      (events) => {
        const actual = events.find(event => event.payload.type === 'check.failed');
        actual.payload.sequence += 1;
        actual.content_hash = computeContentHash(actual);
      },
      (events) => {
        const markerIndex = events.findIndex(event => event.payload.bounded_payload.batch_plan?.committed === true);
        events.splice(markerIndex, 1);
      },
    ];
    for (const tamper of tamperCases) {
      const tampered = durableStore();
      tampered.events.push(...structuredClone(acceptedEvents));
      tampered.setCursor('legacy-journal', tampered.events.at(-1).payload.sequence);
      tamper(tampered.events);
      await expect(runFlowMonitorPass(context(
        tampered,
        async () => { throw new Error('tampered accepted plan must not gather'); },
        async () => {},
      ))).rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
    }

    const missingPlan = durableStore();
    const retainedActual = structuredClone(actualEvents);
    retainedActual.at(-1).payload.bounded_payload.checkpoint_complete = false;
    retainedActual.at(-1).payload.bounded_payload.snapshot = null;
    retainedActual.at(-1).content_hash = computeContentHash(retainedActual.at(-1));
    missingPlan.events.push(...retainedActual);
    missingPlan.setCursor('legacy-journal', retainedActual.at(-1).payload.sequence);
    missingPlan.getEvent = undefined;
    await expect(runFlowMonitorPass(context(
      missingPlan,
      async () => { throw new Error('committed plan loss must not gather'); },
      async () => {},
    ))).rejects.toMatchObject({
      code: 'MONITOR_HISTORY_INCOMPLETE',
      message: 'Durable monitor transition plan marker is missing',
    });
  }, 30_000);

  test('supersedes an orphaned pre-commit recovery plan with a fresh observation', async () => {
    const store = durableStore();
    const checks = Array.from({ length: 128 }, (_, index) => ({
      name: Array.from({ length: 4 }, (_value, salt) => computeContentHash({ index, salt })).join(''),
      class: 'green',
    }));
    let next = snapshot({ checks });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({ checks: checks.map(check => ({ ...check, class: 'failed' })) });

    const appendEvent = store.appendEvent.bind(store);
    store.appendEvent = async (...args) => {
      if (args[0].payload.bounded_payload.batch_plan?.index === 1) {
        throw new Error('pre-commit plan interruption');
      }
      return appendEvent(...args);
    };
    await expect(runFlowMonitorPass(ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    store.appendEvent = appendEvent;

    const resumed = await runFlowMonitorPass(ctx);

    expect(resumed.events.filter(event => event.type === 'check.failed')).toHaveLength(128);
    expect(delivered.filter(event => event.type === 'check.failed')).toHaveLength(128);
    expect(store.events.at(-1).payload.bounded_payload.checkpoint_complete).toBe(true);
  }, 30_000);

  test('recovers a retained suffix of an accepted transition batch', async () => {
    const store = durableStore();
    const checks = Array.from({ length: 130 }, (_, index) => ({ name: `check-${index}`, class: 'green' }));
    let next = snapshot({ checks });
    const ctx = context(store, async () => next, async () => {});
    await runFlowMonitorPass(ctx);

    next = snapshot({ checks: checks.map(check => ({ ...check, class: 'failed' })) });
    const appendEvent = store.appendEvent;
    let appends = 0;
    store.appendEvent = async (...args) => {
      appends += 1;
      if (appends === 130) throw new Error('late storage failure');
      return appendEvent(...args);
    };

    await expect(runFlowMonitorPass(ctx)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    store.appendEvent = appendEvent;
    ctx.gather = async () => { throw new Error('retained suffix recovery must precede provider state'); };

    const resumed = await runFlowMonitorPass(ctx);

    expect(resumed.events).toHaveLength(1);
    expect(store.events.at(-1).payload.bounded_payload.checkpoint_complete).toBe(true);
  });

  test('validates every transition record before the first durable mutation', async () => {
    const store = durableStore();
    let next = snapshot({ prState: 'OPEN', checks: [{ name: 'ci', class: 'green' }] });
    const ctx = context(store, async () => next, async () => {});
    await runFlowMonitorPass(ctx);
    const before = store.events.length;

    next = snapshot({ prState: 'MERGED', checks: [{ name: 'ci', class: 'failed' }] });
    ctx.enrich = async records => {
      expect(records.length).toBeGreaterThan(1);
      Object.assign(records[1].data, Object.fromEntries(Array.from({ length: 24 }, (_, outer) => [
        `group-${outer}`,
        Object.fromEntries(Array.from({ length: 24 }, (_, inner) => [`item-${inner}`, 'x'.repeat(64)])),
      ])));
    };

    await expect(runFlowMonitorPass(ctx)).rejects.toMatchObject({
      code: 'INVALID_OBSERVATION', message: 'MonitorEvent validation failed',
    });
    expect(store.events).toHaveLength(before);
  });

  test('preserves the provider root cause when durable history is unavailable', async () => {
    const store = durableStore();
    const cause = new Error('socket closed');
    store.readEventTail = async () => { throw cause; };

    try {
      await runFlowMonitorPass(context(store, async () => snapshot(), async () => {}));
      throw new Error('expected durable history failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', cause });
    }
  });

  test('maps malformed getEvent persistence JSON to incomplete durable history', async () => {
    const store = durableStore();
    store.getEvent = async () => ({ envelope_json: '{broken-json' });
    store.events.push({
      payload: { monitor_id: 'pr:owner/forge:42', event_id: 'a'.repeat(64), sequence: 1 },
    });

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => {})))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('bounds high-cardinality snapshots before Flow validation and durable persistence', async () => {
    const store = durableStore();
    const large = snapshot({
      checks: Array.from({ length: 100 }, (_, index) => ({ name: `check-${index}-${'x'.repeat(256)}`, class: 'green' })),
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `thread-${index}-${'x'.repeat(256)}`, isResolved: false, isOutdated: false,
        commentCount: 1, actionable: true, path: `path-${index}-${'x'.repeat(256)}`,
      })),
      reviews: Array.from({ length: 100 }, (_, index) => ({ author: `reviewer-${index}-${'x'.repeat(256)}`, state: 'APPROVED' })),
      comments: Array.from({ length: 100 }, (_, index) => ({ id: `comment-${index}-${'x'.repeat(256)}`, author: 'author' })),
    });

    const result = await runFlowMonitorPass(context(store, async () => large, async () => {}));

    expect(result.changed).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(store.events.at(-1).payload.bounded_payload))).toBeLessThanOrEqual(16_384);
  });

  test('bounds enriched failure records before Flow validation and durable persistence', async () => {
    const store = durableStore();
    let next = snapshot({ checks: [{ name: 'ci', class: 'green' }] });
    const ctx = context(store, async () => next, async () => {});
    await runFlowMonitorPass(ctx);
    next = snapshot({ checks: [{ name: 'ci', class: 'failed' }] });
    ctx.enrich = async records => {
      const failed = records.find(record => record.type === 'check.failed');
      failed.data.excerpt = `failure:${'x'.repeat(32_768)}`;
    };

    await runFlowMonitorPass(ctx);

    expect(Buffer.byteLength(JSON.stringify(store.events.at(-1).payload.bounded_payload))).toBeLessThanOrEqual(16_384);
  });

  test('redacts unsafe degraded provider diagnostics before durable and legacy persistence', async () => {
    const store = durableStore();
    const delivered = [];
    const unsafe = 'token=supersecret123 from /home/runner/work/private/repo';

    await runFlowMonitorPass(context(
      store,
      async () => snapshot({ degraded: [{ surface: 'checks', error: unsafe }] }),
      async record => delivered.push(record),
    ));

    const durable = store.events.find(event => event.payload.type === 'monitor.degraded')
      ?.payload.bounded_payload.record.data.error;
    const legacy = delivered.find(record => record.type === 'monitor.degraded')?.data.error;
    expect(durable).toBe('[provider diagnostic redacted]');
    expect(legacy).toBe('[provider diagnostic redacted]');
  });

  test('preserves valid enriched job URLs longer than the generic snapshot text bound', async () => {
    const store = durableStore();
    let next = snapshot({ checks: [{ name: 'ci', class: 'green' }] });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({ checks: [{ name: 'ci', class: 'failed' }] });
    const jobUrl = `https://github.com/owner/forge/actions/runs/${'1234567890'.repeat(10)}/job/987654321`;
    ctx.enrich = async records => {
      records.find(record => record.type === 'check.failed').data.jobUrl = jobUrl;
    };

    await runFlowMonitorPass(ctx);

    const failure = delivered.find(record => record.type === 'check.failed');
    expect(failure.data.jobUrl).toBe(jobUrl);
    expect(store.events.at(-1).payload.bounded_payload.record.data.jobUrl).toBe(jobUrl);
  });

  test('omits credential-bearing enriched job URLs before durable and legacy persistence', async () => {
    const store = durableStore();
    let next = snapshot({ checks: [{ name: 'ci', class: 'green' }] });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({ checks: [{ name: 'ci', class: 'failed' }] });
    ctx.enrich = async records => {
      records.find(record => record.type === 'check.failed').data.jobUrl = 'https://ci.example/job/1?token=supersecret123';
    };

    await runFlowMonitorPass(ctx);

    const failure = delivered.find(record => record.type === 'check.failed');
    expect(failure.data.jobUrl).toBeUndefined();
    expect(store.events.at(-1).payload.bounded_payload.record.data.jobUrl).toBeUndefined();
  });

  test.each([
    'https://user:password@ci.example/job/1',
    'https://ci.example/job/1?sig=opaque',
    'https://ci.example/job/1#credential',
  ])('omits non-public enriched job URL %s', async (jobUrl) => {
    const store = durableStore();
    let next = snapshot({ checks: [{ name: 'ci', class: 'green' }] });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({ checks: [{ name: 'ci', class: 'failed' }] });
    ctx.enrich = async records => { records.find(record => record.type === 'check.failed').data.jobUrl = jobUrl; };

    await runFlowMonitorPass(ctx);

    expect(delivered.find(record => record.type === 'check.failed')?.data.jobUrl).toBeUndefined();
  });

  test('preserves long repository identity in bounded durable and compatibility records', async () => {
    const store = durableStore();
    const repo = `owner/${'repository'.repeat(10)}`;
    const delivered = [];
    await runFlowMonitorPass(context(
      store,
      async () => snapshot({ repo }),
      async record => delivered.push(record),
    ));

    expect(store.events.at(-1).payload.bounded_payload.snapshot.repo).toBe(repo);
    expect(store.events.at(-1).payload.bounded_payload.record.repo).toBe(repo);
    expect(delivered.at(-1).repo).toBe(repo);
  });

  test('keeps long compatibility event identities collision-resistant', async () => {
    const store = durableStore();
    const sharedPrefix = 'check-'.padEnd(80, 'x');
    let next = snapshot({
      checks: [
        { name: `${sharedPrefix}-one`, class: 'green' },
        { name: `${sharedPrefix}-two`, class: 'green' },
      ],
    });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({
      checks: [
        { name: `${sharedPrefix}-one`, class: 'failed' },
        { name: `${sharedPrefix}-two`, class: 'failed' },
      ],
    });

    await runFlowMonitorPass(ctx);

    const failures = delivered.filter(record => record.type === 'check.failed');
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map(record => record.key)).size).toBe(2);
    expect(new Set(failures.map(record => record.data.name)).size).toBe(2);
  });

  test('checkpoints non-event snapshot changes so recurring failures are observed', async () => {
    const store = durableStore();
    let next = snapshot({ checks: [{ name: 'ci', class: 'failed' }] });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({ checks: [{ name: 'ci', class: 'pending' }] });
    await runFlowMonitorPass(ctx);
    next = snapshot({ checks: [{ name: 'ci', class: 'failed' }] });
    await runFlowMonitorPass(ctx);

    expect(delivered.filter(record => record.type === 'check.failed')).toHaveLength(1);
    expect(store.events.some(event => event.payload.type === 'monitor.checkpoint')).toBe(true);
  });

  test('advances delivery authority across more than one bounded tail of advisory checkpoints', async () => {
    const store = durableStore();
    let revision = 0;
    const delivered = [];
    const ctx = context(store, async () => snapshot({ diagnosticRevision: revision }), async record => delivered.push(record));
    await runFlowMonitorPass(ctx);

    for (revision = 1; revision <= 130; revision += 1) await runFlowMonitorPass(ctx);

    const delivery = await store.readDeliveryState(ctx.monitorId);
    expect(delivery.cursors).toContainEqual(expect.objectContaining({
      target: 'legacy-journal', sequence: store.events.at(-1).payload.sequence,
    }));
    expect(delivered.every(record => record.type !== 'monitor.checkpoint')).toBe(true);
  }, 15_000);

  test('retains transition identity beyond the first three snapshot entries', async () => {
    const store = durableStore();
    let next = snapshot({
      checks: Array.from({ length: 4 }, (_, index) => ({ name: `check-${index}`, class: 'green' })),
    });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({
      checks: Array.from({ length: 4 }, (_, index) => ({
        name: `check-${index}`,
        class: index === 3 ? 'failed' : 'green',
      })),
    });

    await runFlowMonitorPass(ctx);

    expect(delivered.some(record => record.type === 'check.failed')).toBe(true);
  });

  test('rejects truncated durable history instead of treating it as a complete restart checkpoint', async () => {
    const store = durableStore();
    store.readEventTail = async () => ({ events: [], overflow: true, truncated_before_sequence: 1 });

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => {})))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('uses a contiguous bounded tail as a restart checkpoint after history exceeds the limit', async () => {
    const store = durableStore();
    await seedHistory(store, 129);
    let next = snapshot({ headSha: 'f'.repeat(40) });
    const ctx = context(store, async () => next, async () => {});

    const before = store.events.at(-1).payload.sequence;
    const resumed = await runFlowMonitorPass(ctx);

    expect(store.events.length).toBeGreaterThan(128);
    expect(resumed.changed).toBe(true);
    expect(resumed.events[0].seq).toBe(before + 1);
  });

  test('continues after acknowledged historical outbox rows exceed the read bound', async () => {
    const store = durableStore();
    await seedHistory(store, 129);
    store.setOutboxOverflow(true);
    const current = structuredClone(store.events.at(-1).payload.bounded_payload.snapshot);

    const result = await runFlowMonitorPass(context(store, async () => current, async () => {}));

    expect(result.events).toEqual([]);
  });

  test('rejects a truncated restart checkpoint when delivery predates its first retained event', async () => {
    const store = durableStore();
    await seedHistory(store, 129);
    const ctx = context(store, async () => snapshot(), async () => {});
    store.setCursor('legacy-journal', 0);

    await expect(runFlowMonitorPass(ctx))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('reconstructs pending delivery from the event tail when historical outbox rows overflow', async () => {
    const store = durableStore();
    await seedHistory(store, 129);
    store.setOutboxOverflow(true);
    store.setCursor('legacy-journal', 128);
    const delivered = [];
    const current = structuredClone(store.events.at(-1).payload.bounded_payload.snapshot);

    const result = await runFlowMonitorPass(context(
      store, async () => current, async record => delivered.push(record),
    ));

    expect(delivered.map(record => record.seq)).toEqual([129]);
    expect(result.receiptIds).toHaveLength(1);
  });

  test('rejects content-corrupted durable history before provider observation', async () => {
    const store = durableStore();
    await runFlowMonitorPass(context(store, async () => snapshot(), async () => {}));
    store.events[0].payload.bounded_payload.snapshot.headSha = 'b'.repeat(40);

    await expect(runFlowMonitorPass(context(store, async () => {
      throw new Error('corrupt replay must not poll the provider');
    }, async () => {}))).rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('rejects malformed compact snapshot evidence as incomplete history', async () => {
    const store = durableStore();
    await runFlowMonitorPass(context(store, async () => snapshot(), async () => {}));
    store.events[0].payload.bounded_payload.snapshot._snapshotEvidence = 'not-gzip-evidence';
    store.events[0].content_hash = computeContentHash(store.events[0]);

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => {})))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('records one terminal receipt after merged evidence and replays its id', async () => {
    const store = durableStore();
    const merged = snapshot({ state: 'MERGED' });
    const first = await runFlowMonitorPass(context(store, async () => merged, async () => {}));
    const replay = await runFlowMonitorPass(context(store, async () => {
      throw new Error('terminal replay must not poll the provider');
    }, async () => {}));

    expect(first.terminalReceiptId).toBeString();
    expect(first.receiptIds).toContain(first.terminalReceiptId);
    expect(store.terminalReceipt.payload).toMatchObject({
      terminal_state: 'PASS',
      cancellation_acknowledged: false,
      lease_cleanup: { continuing_authority: false },
    });
    expect(replay.terminalReceiptId).toBe(first.terminalReceiptId);
  });

  test('starts a new lifecycle when a terminal closed PR is reopened', async () => {
    const store = durableStore();
    let next = snapshot({ state: 'CLOSED' });
    const ctx = context(store, async () => next, async () => {});
    const closed = await runFlowMonitorPass(ctx);
    next = snapshot({ state: 'OPEN' });

    const reopened = await runFlowMonitorPass(ctx);

    expect(closed.terminalReceiptId).toBeString();
    expect(reopened.terminalReceiptId).toBeUndefined();
    expect(reopened.changed).toBe(true);
    expect(store.events.some(event => event.payload.monitor_id !== ctx.monitorId)).toBe(true);
  });

  test('fails closed when reopened lifecycle depth exceeds the bounded chain', async () => {
    const store = durableStore();
    let next = snapshot({ state: 'CLOSED' });
    const ctx = context(store, async () => next, async () => {});
    await runFlowMonitorPass(ctx);
    next = snapshot({ state: 'OPEN' });

    await expect(runFlowMonitorPass(ctx, 8))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('preserves raw display fields while routing observations through a reopened lifecycle', async () => {
    const store = durableStore();
    let next = snapshot({ state: 'CLOSED', checks: [] });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({ state: 'OPEN', checks: [{ name: 'ci-display', class: 'green' }] });
    await runFlowMonitorPass(ctx);
    next = snapshot({ state: 'OPEN', checks: [{ name: 'ci-display', class: 'failed' }] });

    await runFlowMonitorPass(ctx);

    expect(delivered.find(record => record.type === 'check.failed')?.data.name).toBe('ci-display');
  });

  test('continues a reopened lifecycle through a later merged terminal receipt with a bounded id', async () => {
    const store = durableStore();
    let next = snapshot({ state: 'CLOSED' });
    const ctx = context(store, async () => next, async () => {});
    ctx.monitorId = `pr:${'x'.repeat(90)}:42`;
    const closed = await runFlowMonitorPass(ctx);
    next = snapshot({ state: 'OPEN' });
    await runFlowMonitorPass(ctx);
    next = snapshot({ state: 'MERGED' });
    const merged = await runFlowMonitorPass(ctx);

    expect(merged.terminalReceiptId).toBeString();
    expect(merged.terminalReceiptId).not.toBe(closed.terminalReceiptId);
    expect(Math.max(...store.events.map(event => event.payload.monitor_id.length))).toBeLessThanOrEqual(128);
  });

  test('rejects a content-corrupted terminal receipt instead of replaying authority', async () => {
    const store = durableStore();
    await runFlowMonitorPass(context(store, async () => snapshot({ state: 'MERGED' }), async () => {}));
    store.terminalReceipt.payload.terminal_reason = 'tampered';

    await expect(runFlowMonitorPass(context(store, async () => {
      throw new Error('corrupt terminal replay must not poll the provider');
    }, async () => {}))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
