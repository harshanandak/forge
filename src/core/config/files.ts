// The port config reads and writes project files through, rooted at the project. Core only sees
// this interface; the Node implementation is the `fs` adapter (src/adapters/fs/), and tests inject
// their own to interleave two writers deterministically.
import { ForgeFailure } from "../../contract/failure.ts";

export const MAX_CONFIG_FILE_BYTES = 1_048_576;
export const MAX_TEMPLATE_FILE_BYTES = 1_048_576;
export const MAX_LOCK_FILE_BYTES = 4_096;

export function fileLimitExceeded(
  path: string,
  maxBytes: number,
): ForgeFailure {
  return new ForgeFailure({
    code: "LIMIT_EXCEEDED",
    message: `${path} exceeds the file size limit of ${maxBytes} bytes`,
    expected: { maxBytes },
    retry: "never",
  });
}
export function removeConflict(path: string): ForgeFailure {
  return new ForgeFailure({
    code: "INPUT_CONFLICT",
    message: `${path} changed since it was read, so it was not removed`,
    retry: "reconcile_first",
    repair: "read the file again, then remove it against what it now holds",
  });
}
export interface ConfigFiles {
  /** Bytes of a project-relative file, or undefined when it does not exist. */
  read(path: string, maxBytes?: number): Uint8Array | undefined;
  /** Replace a file atomically: write a sibling temporary file, then rename it over. */
  write(path: string, bytes: Uint8Array): void;
  /** Remove a file; absent is fine. */
  remove(path: string, expected: Uint8Array): void;
  /** File names in a directory; empty when it does not exist. */
  list(dir: string, maxEntries?: number): readonly string[];
  /** Create a file only if it does not exist; false when it already does. */
  createExclusive(path: string, bytes: Uint8Array): boolean;
}

/** The single config-lane read path. The adapter caps IO; the second check covers injected ports. */
export function readProjectFile(
  files: ConfigFiles,
  path: string,
  maxBytes: number,
): Uint8Array | undefined {
  const bytes = files.read(path, maxBytes);
  if (bytes !== undefined && bytes.byteLength > maxBytes)
    throw fileLimitExceeded(path, maxBytes);
  return bytes;
}
