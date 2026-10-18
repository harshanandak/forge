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

/** Leave current output alone; publish changed output only after its temp file is complete. */
export function writeGenerated(target: string | URL, content: string): boolean {
  const file = target instanceof URL ? fileURLToPath(target) : target;
  try {
    if (readFileSync(file, "utf8") === content) return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }

  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content);
    try {
      renameSync(temporary, file);
    } catch (error) {
      // Windows can refuse a simultaneous replacement after another writer published the same bytes.
      if (readFileSync(file, "utf8") === content) return false;
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}
