export async function childStep<T>(
  name: string,
  run: () => T | Promise<T>,
  cleanup?: () => void | Promise<void>,
): Promise<T> {
  const started = performance.now();
  let value: { result: T } | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    value = { result: await run() };
  } catch (cause) {
    failure = { cause };
  }
  let cleanupFailure: { cause: unknown } | undefined;
  try {
    await cleanup?.();
  } catch (cause) {
    cleanupFailure = { cause };
  }
  if (failure || cleanupFailure) {
    const cause = (failure ?? cleanupFailure)!.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const cleanupDetail =
      failure && cleanupFailure
        ? `\nCleanup failed: ${String(cleanupFailure.cause)}`
        : "";
    throw new Error(
      `${name} after ${Math.round(performance.now() - started)} ms: ${detail}${cleanupDetail}`,
      { cause },
    );
  }
  return value!.result;
}
