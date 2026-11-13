/** One shared pending load for a dynamic import, and a retry after a rejection. */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () =>
    (loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    }));
}
