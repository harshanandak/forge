export async function childStep<T>(
  name: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${name} after ${Math.round(performance.now() - started)} ms: ${detail}`,
      { cause },
    );
  }
}
