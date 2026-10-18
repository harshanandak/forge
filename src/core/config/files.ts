// The port config reads and writes project files through, rooted at the project. Core only sees
// this interface; the Node implementation is the `fs` adapter (src/adapters/fs/), and tests inject
// their own to interleave two writers deterministically.
export interface ConfigFiles {
  /** Bytes of a project-relative file, or undefined when it does not exist. */
  read(path: string): Uint8Array | undefined;
  /** Replace a file atomically: write a sibling temporary file, then rename it over. */
  write(path: string, bytes: Uint8Array): void;
  /** Remove a file; absent is fine. */
  remove(path: string): void;
  /** File names in a directory; empty when it does not exist. */
  list(dir: string): readonly string[];
  /** Create a file only if it does not exist; false when it already does. */
  createExclusive(path: string, bytes: Uint8Array): boolean;
}
