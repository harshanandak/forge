import { readFileSync } from "node:fs";

const PACKAGE_NAME = "forge-workflow";

// Source runs from <root>/src, the built package from <root>/dist/src.
function readVersion(): string {
  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(new URL(relative, import.meta.url), "utf8"),
      );
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "name" in parsed &&
        parsed.name === PACKAGE_NAME &&
        "version" in parsed &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    } catch {
      // not at this depth; try the next candidate
    }
  }
  throw new Error(
    `${PACKAGE_NAME} package.json not found next to ${import.meta.url}`,
  );
}

export const version: string = readVersion();
