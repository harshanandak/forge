import type { AdapterManifest } from "./imports.ts";
import { readJson } from "./repo.ts";

export interface AdapterScan {
  readonly dirs: string[];
  readonly manifests: AdapterManifest[];
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Read `src/adapters/<name>/adapter.json` for every adapter directory; invalid manifests are left out. */
export function scanAdapters(
  paths: readonly string[],
  root?: string,
): AdapterScan {
  const dirs = [
    ...new Set(
      paths
        .map((p) => /^src\/adapters\/([^/]+)\//.exec(p)?.[1])
        .filter((d) => d !== undefined),
    ),
  ].sort();
  const manifests: AdapterManifest[] = [];
  for (const dir of dirs) {
    const path = `src/adapters/${dir}/adapter.json`;
    if (!paths.includes(path)) continue;
    const raw: unknown = readJson(path, root);
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const packages = strings(record.package);
    const executables = strings(record.executable);
    if (
      typeof record.port !== "string" ||
      packages.length + executables.length === 0
    )
      continue;
    manifests.push({ name: dir, packages, executables });
  }
  return { dirs, manifests };
}
