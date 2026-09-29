'use strict';

const { describe, test, expect } = require('bun:test');
const { distance } = require('../../lib/text/levenshtein');

// Expected values were captured from fastest-levenshtein@1.0.16 (the library
// this module replaces), which measures distance over UTF-16 code units.
const TABLE = [
  ['', '', 0],
  ['', 'abc', 3],
  ['abc', '', 3],
  ['abc', 'abc', 0],
  ['kitten', 'sitting', 3],
  ['flaw', 'lawn', 2],
  ['saturday', 'sunday', 3],
  ['a', 'b', 1],
  ['ab', 'ba', 2],
  // Surrogate pairs: each emoji is two UTF-16 code units.
  ['\u{1F600}', '\u{1F601}', 1],
  ['\u{1F600}', '', 2],
  ['a\u{1F600}b', 'ab', 2],
  ['é', 'é', 0],
  ['forge test', 'forge tests', 1],
];

/** Full-matrix reference implementation, used only to cross-check. */
function referenceDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const m = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) m[i][0] = i;
  for (let j = 0; j < cols; j++) m[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[rows - 1][cols - 1];
}

describe('levenshtein distance', () => {
  for (const [a, b, expected] of TABLE) {
    test(`distance(${JSON.stringify(a)}, ${JSON.stringify(b)}) === ${expected}`, () => {
      expect(distance(a, b)).toBe(expected);
      expect(distance(b, a)).toBe(expected);
    });
  }

  test('large inputs match the library values', () => {
    const big1 = 'abcdefghij'.repeat(100);
    const big2 = 'abcdefghik'.repeat(100) + 'xyz';
    expect(distance(big1, big2)).toBe(103);
    expect(distance('a'.repeat(70), 'b'.repeat(33))).toBe(70);
    expect(distance('x'.repeat(64), 'x'.repeat(65))).toBe(1);
  });

  test('agrees with a full-matrix reference on seeded random strings', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = 'abc \u{1F600}';
    const randomString = () => {
      let s = '';
      const len = Math.floor(rand() * 40);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      return s;
    };
    for (let i = 0; i < 300; i++) {
      const a = randomString();
      const b = randomString();
      expect(distance(a, b)).toBe(referenceDistance(a, b));
    }
  });
});
