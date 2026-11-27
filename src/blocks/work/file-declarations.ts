export type FileDeclarationField = "expectedFiles" | "actualFiles" | "filesAt";
export type FileDeclarationPatch = {
  readonly expectedFiles?: string[];
  readonly actualFiles?: string[];
  readonly filesAt?: string;
};
export type FileDeclarationsResult =
  | { readonly ok: true; readonly patch: FileDeclarationPatch }
  | { readonly ok: false; readonly message: string };

type Result =
  | { readonly ok: true; readonly paths: string[] }
  | { readonly ok: false; readonly message: string };

const limit = 1024;
const unsupported = /[\[\]{}()]/;
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
    path.startsWith("/") ||
    path.startsWith("!") ||
    /^[A-Za-z]:/.test(path) ||
    path.endsWith("/") ||
    path === "." ||
    path.endsWith("/.")
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
  return normalized.length > 0 &&
    normalized.length <= limit &&
    !normalized.startsWith("!")
    ? normalized
    : undefined;
}

function normalizePaths(
  value: unknown,
  field: "expectedFiles" | "actualFiles",
  maximum: number,
): Result {
  if (!Array.isArray(value) || value.length > maximum)
    return problem(field, maximum);
  const paths: string[] = [];
  for (const path of value) {
    const normalized = normalizePath(path);
    if (normalized === undefined) return problem(field, maximum);
    paths.push(normalized);
  }
  return { ok: true, paths };
}

export function normalizeFileDeclarations(
  input: unknown,
  fields: readonly FileDeclarationField[],
): FileDeclarationsResult {
  if (typeof input !== "object" || input === null)
    return { ok: false, message: "file declarations require an object input" };
  const record = input as Record<string, unknown>;
  const patch: {
    expectedFiles?: string[];
    actualFiles?: string[];
    filesAt?: string;
  } = {};
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) continue;
    if (field === "filesAt") {
      if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
        return {
          ok: false,
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
  return { ok: true, patch };
}
