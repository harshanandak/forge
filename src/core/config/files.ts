// The port config reads and writes project files through, rooted at the project. Core only sees
// this interface; the Node implementation is the `fs` adapter (src/adapters/fs/), and tests inject
// their own to interleave two writers deterministically.
import { ForgeFailure } from "../../contract/failure.ts";

export const MAX_CONFIG_FILE_BYTES = 1_048_576;
export const MAX_TEMPLATE_FILE_BYTES = 1_048_576;
// A receipt base64-encodes the previous config, so it needs room for expansion.
export const MAX_RECEIPT_FILE_BYTES = 2_097_152;
export const MAX_LOCK_FILE_BYTES = 4_096;
export const MAX_HISTORY_FILES = 1_000;

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
export interface ConfigFiles {
  /** Bytes of a project-relative file, or undefined when it does not exist. */
  read(path: string, maxBytes?: number): Uint8Array | undefined;
  /** Replace a file atomically: write a sibling temporary file, then rename it over. */
  write(path: string, bytes: Uint8Array): void;
  /** Remove a file; absent is fine. */
  remove(path: string): void;
  /** File names in a directory; empty when it does not exist. */
  list(dir: string): readonly string[];
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
