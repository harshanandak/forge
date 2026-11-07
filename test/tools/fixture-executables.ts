import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

// A freshly written .exe draws scanners on hosted Windows runners (provjobd.exe held
// <root>\bin\claude.exe, which made the rm of the root fail with EBUSY). A per-test root is removed
// right after the test, so no executable may be written into one: compile it once into a shared
// directory that is removed at the end of the file instead.
export function executablesUnder(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
      .map((entry) => relative(root, join(entry.parentPath, entry.name)));
  } catch {
    return [];
  }
}
