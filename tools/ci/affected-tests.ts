import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { importsOf } from "../../test/structure/lib/imports.ts";
import { changedPaths } from "./change-scope.ts";

const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
const sources = new Bun.Glob(
  "{src,tools,test}/**/*.{" + extensions.join(",") + "}",
);
const configs =
  /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|\.forge\/config\.yaml)$/;
const localSpecifier = /^(?:#|file:|forge-workflow(?:\/|$))/;
const sourceTest = (path: string) =>
  /^(?:src|test)\/.*\.test\.ts$/.test(path) &&
  !path.endsWith("/packed.integration.test.ts");

function sharedRule(path: string): string | undefined {
  if (configs.test(path)) return "shared configuration";
  if (/^(?:\.github|tools\/ci|tools\/gen)\//.test(path)) return "CI input";
  if (
    path.startsWith("test/") &&
    (!sourceTest(path) || /\/(?:fixtures|node-fixtures|lib)\//.test(path))
  )
    return "test support";
  if (path.startsWith("src/") && !/\.(?:[cm]?ts|tsx)$/.test(path))
    return "non-TypeScript source";
}

function reachable(
  reverse: ReadonlyMap<string, string[]>,
  roots: readonly string[],
): Set<string> {
  const found = new Set(roots);
  for (const path of found)
    for (const consumer of reverse.get(path) ?? []) found.add(consumer);
  return found;
}

function selection(
  files: string[],
  reason: string,
  opaque: string[] = [],
  alwaysSelected: string[] = [],
) {
  const count = files.length;
  const fallback = reason !== "";
  return { files, count, fallback, reason, opaque, alwaysSelected };
}

export function affectedTests(
  files: ReadonlyMap<string, string>,
  changed: readonly string[],
) {
  const tests = [...files.keys()].filter(sourceTest).sort();
  const reverse = new Map<string, string[]>();
  const opaque = new Set<string>();
  for (const [path, text] of files) {
    let imports: string[];
    try {
      imports = importsOf({ path, text }, () => opaque.add(path));
    } catch {
      opaque.add(path);
      continue;
    }
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) {
        if (localSpecifier.test(specifier) || win32.isAbsolute(specifier))
          opaque.add(path);
        continue;
      }
      const base = posix.join(posix.dirname(path), specifier);
      const targets = [
        base,
        base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2"),
        ...extensions.flatMap((ext) => [
          base + "." + ext,
          posix.join(base, "index." + ext),
        ]),
      ].filter((target) => files.has(target));
      if (!targets.length) opaque.add(path);
      for (const target of new Set(targets)) {
        const consumers = reverse.get(target) ?? [];
        consumers.push(path);
        reverse.set(target, consumers);
      }
    }
  }
  const opaqueFiles = [...opaque].sort();
  const opaqueReach = reachable(reverse, opaqueFiles);
  const alwaysSelected = tests.filter((file) => opaqueReach.has(file));
  for (const path of changed) {
    const rule =
      sharedRule(path) ?? (files.has(path) ? undefined : "outside the graph");
    if (rule)
      return selection(tests, rule + ": " + path, opaqueFiles, alwaysSelected);
  }
  const affected = reachable(reverse, changed);
  const selected = changed.length
    ? tests.filter((file) => affected.has(file) || opaqueReach.has(file))
    : [];
  return selected.length
    ? selection(selected, "", opaqueFiles, alwaysSelected)
    : selection(tests, "empty selection", opaqueFiles, alwaysSelected);
}

if (import.meta.main) {
  const { BASE_SHA, HEAD_SHA, CI_SHARD, GITHUB_STEP_SUMMARY } = process.env;
  const [manifest] = process.argv.slice(2);
  const cwd = process.cwd();
  let tests: string[] = [];
  let result: ReturnType<typeof affectedTests>;
  try {
    const paths = [...sources.scanSync({ cwd })].map((path) =>
      path.replaceAll("\\", "/"),
    );
    tests = paths.filter(sourceTest).sort();
    if (!BASE_SHA || !HEAD_SHA) throw new Error("missing base or head SHA");
    const files = new Map(
      paths.map((path) => [path, readFileSync(path, "utf8")]),
    );
    result = affectedTests(files, changedPaths(BASE_SHA, HEAD_SHA, cwd));
  } catch (error) {
    result = selection(tests, "scanner failure: " + String(error));
  }
  if (manifest) writeFileSync(manifest, JSON.stringify(result));
  if (GITHUB_STEP_SUMMARY) {
    const details = JSON.stringify(result, null, 2).replace(/^/gm, "    ");
    const summary =
      !result.fallback && CI_SHARD !== "1/3"
        ? "no files assigned: affected selection ran in shard 1\n"
        : `### Affected Windows tests\n\nOpaque nodes: ${result.opaque.length}. Always-selected tests: ${result.alwaysSelected.length}.\n\n${details}\n`;
    appendFileSync(GITHUB_STEP_SUMMARY, summary);
    console.error(summary);
  }
  if (manifest) console.log("selected=" + !result.fallback);
  else console.log(JSON.stringify(result));
}
