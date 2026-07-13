'use strict';

const { describe, test, expect } = require('bun:test');

const {
  SCHEMA_VERSION, EVENT_TYPES, makeEvent, finalizeEvent, eventIdentity,
  canonicalStringify, fingerprint,
} = require('../../lib/pr-monitor/events');

describe('events — schema + envelope', () => {
  test('makeEvent stringifies the key and defaults data', () => {
    expect(makeEvent('head.pushed', 123)).toEqual({ type: 'head.pushed', key: '123', data: {} });
  });

  test('finalizeEvent builds the full v1 record', () => {
    const rec = finalizeEvent(makeEvent('check.failed', 'ci:sha1', { name: 'ci' }), {
      seq: 4, ts: 'T', repo: 'r', pr: 7, headSha: 'sha1', verdict: { state: 'BLOCKED', reason: 'x' },
    });
    expect(rec).toEqual({
      v: SCHEMA_VERSION, seq: 4, ts: 'T', repo: 'r', pr: '7', headSha: 'sha1',
      type: 'check.failed', key: 'ci:sha1', data: { name: 'ci' },
      verdict: { state: 'BLOCKED', reason: 'x' },
    });
  });

  test('finalizeEvent tolerates a missing verdict (fail-closed nulls)', () => {
    const rec = finalizeEvent(makeEvent('pr.merged', 'MERGED'), { seq: 1, ts: 'T', repo: 'r', pr: '1', headSha: null, verdict: null });
    expect(rec.verdict).toEqual({ state: null, reason: null });
    expect(rec.headSha).toBe(null);
  });

  test('every event type is present', () => {
    expect(EVENT_TYPES.VERDICT_CHANGED).toBe('verdict.changed');
    expect(EVENT_TYPES.MONITOR_DEGRADED).toBe('monitor.degraded');
  });
});

describe('events — identity + fingerprint', () => {
  test('eventIdentity is a collision-safe (type,key) pair', () => {
    expect(eventIdentity({ type: 'a.b', key: 'k' })).not.toBe(eventIdentity({ type: 'a', key: 'b.k' }));
  });

  test('canonicalStringify sorts keys so equal objects serialize identically', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  test('fingerprint is stable for equal input and changes on any change', () => {
    const a = fingerprint({ x: 1, y: [1, 2] });
    expect(fingerprint({ y: [1, 2], x: 1 })).toBe(a);
    expect(fingerprint({ x: 1, y: [1, 3] })).not.toBe(a);
  });
});
