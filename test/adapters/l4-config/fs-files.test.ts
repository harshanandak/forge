// The ConfigFiles port: core config reaches the filesystem only through it, and the `fs` adapter is
// its Node implementation. The contract suite runs against that adapter.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeConfigFiles } from "../../../src/adapters/fs/index.ts";
import { importsOf } from "../../structure/lib/imports.ts";
import { scanAdapters } from "../../structure/lib/adapters.ts";
import { listRepoFiles } from "../../structure/lib/repo.ts";

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const made = mkdtempSync(join(tmpdir(), "forge-l4-fs-"));
  roots.push(made);
  return made;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined): string | undefined =>
  data === undefined ? undefined : new TextDecoder().decode(data);

describe("the fs adapter implements ConfigFiles", () => {
  test("reads, atomically replaces, lists and removes project-relative files", () => {
    const dir = root();
    const files = nodeConfigFiles(dir);
    expect(files.read(".forge/config.yaml")).toBeUndefined();
    expect(files.list(".forge")).toEqual([]);
    files.write(".forge/config.yaml", bytes("a: 1\n"));
    files.write(".forge/config.yaml", bytes("a: 2\n"));
    expect(text(files.read(".forge/config.yaml"))).toBe("a: 2\n");
    expect(readFileSync(join(dir, ".forge", "config.yaml"), "utf8")).toBe(
      "a: 2\n",
    );
    // no temporary file is left beside it
    expect(readdirSync(join(dir, ".forge"))).toEqual(["config.yaml"]);
    files.write(".forge/config-history/000002.json", bytes("{}"));
    files.write(".forge/config-history/000001.json", bytes("{}"));
    expect(files.list(".forge/config-history")).toEqual([
      "000001.json",
      "000002.json",
    ]);
    files.remove(".forge/config.yaml");
    files.remove(".forge/config.yaml");
    expect(files.read(".forge/config.yaml")).toBeUndefined();
  });

  test("createExclusive creates once and refuses while the file exists", () => {
    const files = nodeConfigFiles(root());
    expect(files.createExclusive(".forge/config.lock", bytes("one"))).toBe(
      true,
    );
    expect(files.createExclusive(".forge/config.lock", bytes("two"))).toBe(
      false,
    );
    expect(text(files.read(".forge/config.lock"))).toBe("one");
    files.remove(".forge/config.lock");
    expect(files.createExclusive(".forge/config.lock", bytes("three"))).toBe(
      true,
    );
  });
});

describe("the filesystem stays behind the adapter", () => {
  const REPO = fileURLToPath(new URL("../../../", import.meta.url));

  test("core config imports no filesystem or path built-in", () => {
    const core = listRepoFiles().filter((p) =>
      /^src\/core\/config\/.*\.ts$/.test(p),
    );
    expect(core.length).toBeGreaterThan(0);
    const leaks = core.flatMap((path) =>
      importsOf({ path, text: readFileSync(join(REPO, path), "utf8") })
        .filter((s) => /^(?:node:)?(?:fs|path)(?:\/|$)/.test(s))
        .map((s) => `${path} imports ${s}`),
    );
    expect(leaks).toEqual([]);
  });

  test("the fs adapter has a manifest the structure guard accepts", () => {
    const { manifests } = scanAdapters(listRepoFiles());
    expect(manifests.map((m) => m.name)).toContain("fs");
  });
});
