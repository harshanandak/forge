'use strict';

const { describe, test, expect } = require('bun:test');

const {
  estimateTokens,
  memoryTrustStatus,
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

  test('keeps non-Latin content tokens (guard must not disable recall for non-Latin scripts)', () => {
    // Cyrillic "fix the auth bug" — the ASCII-only split used to strip all of this to [].
    expect(meaningfulTokens('исправь баг авторизации').length).toBeGreaterThanOrEqual(2);
    // CJK tokens are short but inherently content — the length filter must not drop them.
    expect(meaningfulTokens('修复 认证').length).toBeGreaterThanOrEqual(2);
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
      tokenBudget: 180, // room for ~1 fully labeled and fenced body
      excludeKeys: [],
    });
    expect(out.injectedKeys.length).toBeLessThan(3);
    expect(out.injectedKeys.length).toBeGreaterThanOrEqual(1);
  });

  test('skips an oversized best hit and packs a later fitting hit with trust and provenance labels', () => {
    const out = selectInjection({
      query: 'auth token bug',
      hits: [
        { memory_id: 'oversized', content: 'x'.repeat(2_000), score: -3, trust_status: 'confirmed' },
        {
          memory_id: 'fits',
          content: 'Use the clock-skew fix.',
          score: -2,
          trust_status: 'suggested',
          provenance: { source_agent: 'forge insights' },
          updated_at: '2026-07-30T00:00:00.000Z',
        },
      ],
      scoreFloor: -1,
      tokenBudget: 100,
    });

    expect(out.injectedKeys).toEqual(['fits']);
    expect(out.entries[0].trust).toBe('suggested');
    expect(out.entries[0].line).toContain('trust=suggested');
    expect(out.entries[0].line).toContain('source=forge insights');
    expect(estimateTokens(
      `Suggested memory — verify before relying\n${out.entries[0].line}`,
    )).toBeLessThanOrEqual(100);
  });

  test('no hits -> inject nothing (empty, not a throw)', () => {
    const out = selectInjection({ query: 'auth token bug', hits: [], excludeKeys: [] });
    expect(out.lines).toEqual([]);
    expect(out.injectedKeys).toEqual([]);
  });
});

describe('memory-recall: trust precedence', () => {
  test('explicit suggested and machine markers override the human-string fallback', () => {
    expect(memoryTrustStatus({
      sourceAgent: 'forge remember',
      value: 'candidate',
      tags: ['trust:suggested'],
    })).toBe('suggested');
    expect(memoryTrustStatus({
      sourceAgent: 'forge remember',
      value: 'ambiguous',
      tags: ['trust:unknown'],
    })).toBe('suggested');
    expect(memoryTrustStatus({
      sourceAgent: 'forge remember',
      value: 'captured',
      tags: ['forge:auto-capture'],
    })).toBe('suggested');
    expect(memoryTrustStatus({
      sourceAgent: 'forge remember (imported)',
      value: 'legacy',
      tags: [],
    })).toBe('suggested');
    expect(memoryTrustStatus({
      sourceAgent: 'forge remember',
      value: { category: 'decision', data: 'machine' },
      tags: [],
    })).toBe('suggested');
    expect(memoryTrustStatus({
      sourceAgent: 'forge remember',
      value: 'human note',
      tags: [],
    })).toBe('confirmed');
    expect(memoryTrustStatus({
      sourceAgent: 'forge insights',
      value: 'candidate',
      tags: ['trust:confirmed'],
    })).toBe('confirmed');
  });
});
