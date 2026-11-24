import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function hubTestTemp(prefix: string): string {
  const root = process.platform === "win32" ? homedir() : tmpdir();
  return mkdtempSync(join(root, prefix));
}
