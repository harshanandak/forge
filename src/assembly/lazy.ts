/**
 * Loads a module on first use, so a command pays only for the modules it calls. The module
 * cache already shares the result; this keeps the one pending load and drops a failed one so
 * the next use tries again. Write the import as a literal inside `load` so the build sees it.
 */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () =>
    (loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    }));
}
