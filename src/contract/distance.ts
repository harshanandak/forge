/** Levenshtein distance; a bounded lookup returns at most `limit + 1` for distant names. */
export function nameDistance(
  a: string,
  b: string,
  limit: number = Math.max(a.length, b.length),
): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = Array<number>(b.length + 1).fill(limit + 1);
    next[0] = i + 1;
    let minimum = next[0];
    for (
      let j = Math.max(0, i - limit);
      j < Math.min(b.length, i + limit + 1);
      j++
    ) {
      next[j + 1] = Math.min(
        next[j]! + 1,
        row[j + 1]! + 1,
        row[j]! + (a[i] === b[j] ? 0 : 1),
      );
      minimum = Math.min(minimum, next[j + 1]!);
    }
    if (minimum > limit) return limit + 1;
    row = next;
  }
  return Math.min(row[b.length]!, limit + 1);
}
