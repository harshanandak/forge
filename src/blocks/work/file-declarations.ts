type Field = "expectedFiles" | "actualFiles" | "filesAt";
type Patch = {
  expectedFiles?: string[];
  actualFiles?: string[];
  filesAt?: string;
};
type Result = { ok: true; patch: Patch } | { ok: false; message: string };

const limit = 1024;
const unsupported = /[[\]{}()]/;
const absolute = /^(?:[A-Za-z]:|\/|!)/;
const trailing = /\/\.?$/;
const problem = (field: string, maximum: number) => ({
  ok: false as const,
  message: `${field} must be an array of at most ${maximum} repo-relative paths of at most ${limit} characters, using only / separators and the *, ** and ? glob operators`,
});

function normalizePath(path: unknown): string | undefined {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > limit ||
    path.includes("\\") ||
    absolute.test(path) ||
    path === "." ||
    trailing.test(path)
  )
    return undefined;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || unsupported.test(segment) || /\*{3,}/.test(segment))
      return undefined;
    segments.push(segment);
  }
  const normalized = segments.join("/");
  if (
    normalized.length === 0 ||
    normalized.length > limit ||
    absolute.test(normalized)
  )
    return undefined;
  return normalized;
}

function normalizePaths(
  value: unknown,
  field: "expectedFiles" | "actualFiles",
  maximum: number,
) {
  if (!Array.isArray(value) || value.length > maximum)
    return problem(field, maximum);
  const paths: string[] = [];
  for (const path of value) {
    const normalized = normalizePath(path);
    if (normalized === undefined) return problem(field, maximum);
    paths.push(normalized);
  }
  return { ok: true as const, paths };
}

export function normalizeFileDeclarations(
  input: unknown,
  fields: readonly Field[],
): Result {
  if (typeof input !== "object" || input === null)
    return {
      ok: false as const,
      message: "file declarations require an object input",
    };
  const record = input as Record<string, unknown>;
  const patch: Patch = {};
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) continue;
    if (field === "filesAt") {
      if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
        return {
          ok: false as const,
          message: "filesAt must be a lowercase 40-character commit SHA",
        };
      patch.filesAt = value;
    } else {
      const normalized = normalizePaths(
        value,
        field,
        field === "expectedFiles" ? 256 : 1024,
      );
      if (!normalized.ok) return normalized;
      patch[field] = normalized.paths;
    }
  }
  return { ok: true as const, patch };
}
