'use strict';

/**
 * Levenshtein edit distance between two strings, measured over UTF-16 code
 * units (same semantics as fastest-levenshtein, which this replaces).
 *
 * Two-row dynamic programme; memory is O(min(a.length, b.length)).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distance(a, b) {
  if (a === b) return 0;
  // Keep the shorter string on the row axis so the rows stay small.
  if (a.length < b.length) {
    const t = a;
    a = b;
    b = t;
  }
  const n = b.length;
  if (n === 0) return a.length;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const t = prev;
    prev = curr;
    curr = t;
  }
  return prev[n];
}

module.exports = { distance };
