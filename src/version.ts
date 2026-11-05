import { readFileSync } from "node:fs";

const PACKAGE_NAME = "forge-workflow";
export interface BuildIdentity {
  readonly version: string;
  readonly commit: string | null;
  readonly dirty: boolean;
}

// Source runs from <root>/src, the built package from <root>/dist/src.
function readPackage(): { version: string; root: URL } {
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
        return {
          version: parsed.version,
          root: new URL(".", new URL(relative, import.meta.url)),
        };
      }
    } catch {
      // not at this depth; try the next candidate
    }
  }
  throw new Error(
    `${PACKAGE_NAME} package.json not found next to ${import.meta.url}`,
  );
}

const pkg = readPackage();
export const version: string = pkg.version;
export const packageRoot: URL = pkg.root;

function readBuild(): BuildIdentity {
  try {
    const value: unknown = JSON.parse(
      readFileSync(new URL("../build.json", import.meta.url), "utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      typeof value.version === "string" &&
      "commit" in value &&
      typeof value.commit === "string" &&
      /^[a-f0-9]{40}$/.test(value.commit) &&
      "dirty" in value &&
      typeof value.dirty === "boolean"
    )
      return {
        version: value.version,
        commit: value.commit,
        dirty: value.dirty,
      };
  } catch {
    // Source execution and older artifacts have no recorded build identity.
  }
  return { version, commit: null, dirty: false };
}
export const buildIdentity: BuildIdentity = readBuild();
export const versionLabel: string = `${buildIdentity.version} (${buildIdentity.commit ?? "unbuilt"}${buildIdentity.dirty ? "+dirty" : ""})`;
