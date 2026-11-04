import { posix } from "node:path";
import { nodeSensitive } from "./node-sensitive.ts";

export function selectSourceFiles(files: string[], major: string): string[] {
  if (major !== "24" && major !== "26")
    throw new Error("expected Node 24 or 26");
  return files.filter((file) => major === "24" || file in nodeSensitive);
}

// Conservative: include executable literals, shell shims and configured Node paths.
// Follow local test/tool helpers too; Node built-ins executed by Bun alone do not qualify.
export function nodeReferences(
  files: readonly { path: string; text: string }[],
): string[] {
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  const node =
    /["'`]node(?:\.exe)?(?:["'`]|[ \t])|\bNODE_(?:EXE|PATH|BINARY)\b|process\.(?:versions\.node|version)\b|(?:exec|env) node\b/i;
  const npm =
    /\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?)\s*\(\s*\[?\s*["'`](?:npm|npx)(?:\.cmd)?(?:["'`]|[ \t])/i;
  const imports =
    /(?:from\s*|import\s*\(|require\s*\(|import\s*)["'](\.[^"']+)["']/g;
  const references = (path: string, seen: Set<string>): boolean => {
    if (seen.has(path)) return false;
    seen.add(path);
    const text = byPath.get(path);
    if (text === undefined) return false;
    if (node.test(text) || npm.test(text)) return true;
    return [...text.matchAll(imports)].some((match) => {
      const dependency = posix.normalize(
        posix.join(posix.dirname(path), match[1]!),
      );
      return /^(test|tools)\//.test(dependency) && references(dependency, seen);
    });
  };
  return files
    .filter(
      ({ path }) =>
        path.endsWith(".test.ts") &&
        !path.endsWith("/packed.integration.test.ts") &&
        references(path, new Set()),
    )
    .map(({ path }) => path);
}
