/** Bound real fixture/suite concurrency and drain all work before cleanup. */
export async function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
    throw new RangeError("packed concurrency must be an integer in 1..3");
  const output: R[] = [];
  const failures: unknown[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        try {
          output[index] = await run(items[index]!, index);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length)
    throw new AggregateError(failures, "Packed checks failed");
  return output;
}
