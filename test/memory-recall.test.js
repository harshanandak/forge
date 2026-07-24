'use strict';

const { describe, test, expect } = require('bun:test');

const {
  parseHookInput,
  meaningfulTokens,
  selectInjection,
} = require('../lib/memory-recall');

describe('memory-recall: parseHookInput (hook stdin JSON)', () => {
  test('extracts prompt and session_id from the Claude hook payload', () => {
    const raw = JSON.stringify({ session_id: 's1', prompt: 'fix the auth bug', cwd: '/x' });
    expect(parseHookInput(raw)).toEqual({ prompt: 'fix the auth bug', sessionId: 's1' });
  });

  test('fail-safe: garbage / empty / non-object yields empty prompt, null session', () => {
    expect(parseHookInput('not json')).toEqual({ prompt: '', sessionId: null });
    expect(parseHookInput('')).toEqual({ prompt: '', sessionId: null });
    expect(parseHookInput('[]')).toEqual({ prompt: '', sessionId: null });
    expect(parseHookInput(JSON.stringify({ prompt: 42 }))).toEqual({ prompt: '', sessionId: null });
  });
});

describe('memory-recall: meaningfulTokens (anaphora guard basis)', () => {
  test('keeps distinct content tokens, drops short tokens and stopwords', () => {
    // 'fix' is a generic dev verb (in STOPWORDS) — the discriminating tokens are auth/bug.
    expect(meaningfulTokens('fix the auth bug').sort()).toEqual(['auth', 'bug']);
    // pure anaphora — nothing meaningful survives
    expect(meaningfulTokens('continue')).toEqual([]);
    expect(meaningfulTokens('same for it')).toEqual([]);
    expect(meaningfulTokens('do that now')).toEqual([]);
  });
});

describe('memory-recall: selectInjection', () => {
  const hit = (key, score, body) => ({ key, score, value: body || `body of ${key}` });

  test('anaphora guard: a query with too few meaningful tokens injects nothing', () => {
    const out = selectInjection({
      query: 'continue',
      hits: [hit('m1', -3)],
      excludeKeys: [],
    });
    expect(out.lines).toEqual([]);
    expect(out.injectedKeys).toEqual([]);
  });

  test('score floor: drops hits weaker than the floor; nothing clears -> inject nothing', () => {
    const out = selectInjection({
      query: 'auth token bug',
      hits: [hit('weak', -0.2)],
      scoreFloor: -1.0, // require score <= -1.0 (more negative = stronger)
      excludeKeys: [],
    });
    expect(out.lines).toEqual([]);
  });

  test('keeps hits at or beyond the floor, best-first, and reports injected keys', () => {
    const out = selectInjection({
      query: 'auth token bug',
      hits: [hit('strong', -3.0), hit('mid', -1.5), hit('weak', -0.2)],
      scoreFloor: -1.0,
      tokenBudget: 10000,
      excludeKeys: [],
    });
    expect(out.injectedKeys).toEqual(['strong', 'mid']);
    expect(out.lines.join('\n')).toContain('body of strong');
    expect(out.lines.join('\n')).toContain('body of mid');
    expect(out.lines.join('\n')).not.toContain('body of weak');
  });

  test('cross-turn dedupe: excludeKeys are never re-injected', () => {
    const out = selectInjection({
      query: 'auth token bug',
      hits: [hit('strong', -3.0), hit('seen', -2.9)],
      scoreFloor: -1.0,
      tokenBudget: 10000,
      excludeKeys: ['seen'],
    });
    expect(out.injectedKeys).toEqual(['strong']);
  });

  test('token budget caps how many are packed', () => {
    const big = 'x '.repeat(200); // ~100 tokens each
    const out = selectInjection({
      query: 'auth token bug',
      hits: [hit('a', -3, big), hit('b', -2.9, big), hit('c', -2.8, big)],
      scoreFloor: -1.0,
      tokenBudget: 120, // room for ~1 body
      excludeKeys: [],
    });
    expect(out.injectedKeys.length).toBeLessThan(3);
    expect(out.injectedKeys.length).toBeGreaterThanOrEqual(1);
  });

  test('no hits -> inject nothing (empty, not a throw)', () => {
    const out = selectInjection({ query: 'auth token bug', hits: [], excludeKeys: [] });
    expect(out.lines).toEqual([]);
    expect(out.injectedKeys).toEqual([]);
  });
});
