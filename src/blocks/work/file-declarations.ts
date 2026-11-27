const fields = ["expectedFiles", "actualFiles", "filesAt"] as const;
type Field = (typeof fields)[number];
type Patch = {
  expectedFiles?: string[];
  actualFiles?: string[];
  filesAt?: string;
};
type Result = { ok: true; patch: Patch } | { ok: false; message: string };

const counts = { expectedFiles: 256, actualFiles: 1024 };
const pathLimit = 1024;
const absolute = /^(?:[A-Za-z]:|\/|!)/;
// A v3 frame holds up to three copies, with 16 KiB for the lease and framing.
const MAX_DECLARED_ISSUE_BYTES = (256 * 1024 - 16 * 1024) / 3;
export const FILE_DECLARATION_REFUSALS = {
  paths:
    "File declarations require repo-relative / paths of at most 1024 characters, with at most 256 expected and 1024 actual paths",
  filesAt: "filesAt must be a lowercase 40-character commit SHA",
  size: "File declarations and issue fields exceed the 80 KiB JSON budget",
};

export function jsonBytes(value: unknown): number {
  let bytes = 0;
  for (const char of JSON.stringify(value)) {
    const point = char.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function overFileDeclarationBudget(
  value: object,
  patch = value as Patch,
): boolean {
  return (
    fields.some((field) => patch[field] !== undefined) &&
    jsonBytes(value) > MAX_DECLARED_ISSUE_BYTES
  );
}

function normalizePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    [...value].length > pathLimit ||
    absolute.test(value) ||
    value.includes("\0") ||
    /[\\[\]{}()]|\*{3,}/.test(value)
  )
    return undefined;
  const path = value.replace(/\/{2,}$/, "");
  if (/\/\.?$/.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.includes("..")) return undefined;
  const normalized = parts
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return normalized && !absolute.test(normalized) ? normalized : undefined;
}

export function normalizeFileDeclarations(
  input: object,
  selected: readonly Field[] = fields,
): Result {
  const patch: Patch = {};
  const invalidPaths = {
    ok: false as const,
    message: FILE_DECLARATION_REFUSALS.paths,
  };
  for (const field of selected) {
    const value = (input as Record<Field, unknown>)[field];
    if (value === undefined) continue;
    if (field === "filesAt") {
      if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
        return { ok: false, message: FILE_DECLARATION_REFUSALS.filesAt };
      patch.filesAt = value;
      continue;
    }
    if (!Array.isArray(value) || value.length > counts[field])
      return invalidPaths;
    const paths = value.map(normalizePath);
    if (paths.some((path) => path === undefined)) return invalidPaths;
    patch[field] = paths as string[];
  }
  if (overFileDeclarationBudget(input, patch))
    return { ok: false, message: FILE_DECLARATION_REFUSALS.size };
  return { ok: true, patch };
}
