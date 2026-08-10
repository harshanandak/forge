'use strict';

const { describe, test, expect } = require('bun:test');

const {
  SCHEMA_VERSION, EVENT_TYPES, makeEvent, finalizeEvent, eventIdentity,
  canonicalStringify, fingerprint, decideTransition, TRANSITION_STATUS,
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
    expect(rec.headSha).toBeNull();
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

describe('events - deterministic transition authority', () => {
  const state = (sequence, value = 'same') => ({ subjectRevision: 'head-a', sequence, value });

  test('identical replay is unchanged and consumes no transition', () => {
    expect(decideTransition(state(4), state(4))).toEqual({
      status: TRANSITION_STATUS.UNCHANGED,
      changed: false,
      reason: 'identical transition replay',
    });
  });

  test('same revision and sequence with different content conflicts closed', () => {
    expect(decideTransition(state(4), state(4, 'different'))).toMatchObject({
      status: TRANSITION_STATUS.CONFLICT,
      changed: false,
    });
  });

  test('older sequence is stale and missing authority is incomplete', () => {
    expect(decideTransition(state(4), state(3))).toMatchObject({
      status: TRANSITION_STATUS.STALE,
      changed: false,
    });
    expect(decideTransition(state(4), { sequence: 5 })).toMatchObject({
      status: TRANSITION_STATUS.INCOMPLETE,
      changed: false,
    });
  });

  test('a newer complete sequence is the only actionable transition', () => {
    expect(decideTransition(state(4), { ...state(5), subjectRevision: 'head-b' })).toEqual({
      status: TRANSITION_STATUS.CHANGED,
      changed: true,
      reason: 'newer complete transition',
    });
  });
});
