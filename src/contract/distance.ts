/** Levenshtein distance for spelling suggestions on declared names. */
export function nameDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(
          next[j]! + 1,
          row[j + 1]! + 1,
          row[j]! + (a[i] === b[j] ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[b.length]!;
}
