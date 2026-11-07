import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// A freshly written .exe draws scanners on hosted Windows runners (provjobd.exe held
// <root>\bin\claude.exe, which made the rm of the root fail with EBUSY). A per-test root is removed
// right after the test, so no executable may be written into one: compile it once into a shared
// directory that is removed at the end of the file instead.
const listEntries = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true });

export function executablesUnder(
  root: string,
  list: typeof listEntries = listEntries,
): string[] {
  try {
    return list(root)
      .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
      .map((entry) => relative(root, join(entry.parentPath, entry.name)));
  } catch (error) {
    // Only a missing root means "no executables". An entry that vanishes mid-walk also reports ENOENT,
    // but then the rest of the tree went unscanned, so it and any other failure must fail the guard.
    const { code, path } = (error ?? {}) as NodeJS.ErrnoException;
    if (
      code === "ENOENT" &&
      path !== undefined &&
      resolve(path) === resolve(root)
    )
      return [];
    throw error;
  }
}
