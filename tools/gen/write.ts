import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Windows refuses to open a file while a rename replaces it, and refuses the rename while another handle
// has the target open. Both clear as soon as the other side finishes, so they are retried, not reported.
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const BUSY_RETRY_MS = 2_000;
const pause = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

/** Runs `step` again while the file is busy, up to a bound; any other error, or the bound, throws. */
function whileBusy<T>(step: () => T): T {
  const deadline = Date.now() + BUSY_RETRY_MS;
  for (let wait = 1; ; wait = Math.min(wait * 2, 50)) {
    try {
      return step();
    } catch (error) {
      if (!BUSY.has(code(error) ?? "") || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, wait);
    }
  }
}

/** The two calls a concurrent writer can find busy; a test injects the busy errors here. */
export type GeneratedFiles = {
  read: (file: string) => string;
  rename: (from: string, to: string) => void;
};

const nodeFiles: GeneratedFiles = {
  read: (file) => readFileSync(file, "utf8"),
  rename: renameSync,
};

/** The file's text, or undefined before its first publish. */
function current(file: string, files: GeneratedFiles): string | undefined {
  return whileBusy(() => {
    try {
      return files.read(file);
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw error;
    }
  });
}

/** Leave current output alone; publish changed output only after its temp file is complete. */
export function writeGenerated(
  target: string | URL,
  content: string,
  files: GeneratedFiles = nodeFiles,
): boolean {
  const file = target instanceof URL ? fileURLToPath(target) : target;
  if (current(file, files) === content) return false;

  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content);
    return whileBusy(() => {
      try {
        files.rename(temporary, file);
        return true;
      } catch (error) {
        // Another writer may already have published the same bytes; then nothing is left to replace.
        if (current(file, files) === content) return false;
        throw error;
      }
    });
  } finally {
    rmSync(temporary, { force: true });
  }
}
