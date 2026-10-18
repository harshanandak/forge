// The ConfigFiles port: core config reaches the filesystem only through it, and the `fs` adapter is
// its Node implementation. The contract suite runs against that adapter.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfigFiles } from "../../../src/adapters/fs/index.ts";

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

// Directory links are junctions on Windows (no privilege needed); file links need symlink privilege
// there, so those cases are skipped — and say so — only when the OS refuses to create one.
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, "junction");
}
function tryLinkFile(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      console.warn(`skipped: this OS cannot create file symlinks (${link})`);
      return false;
    }
    throw error;
  }
}

describe("the fs adapter refuses to leave the project root", () => {
  test("a symlinked config file pointing outside the root is neither read nor replaced", () => {
    const outside = root();
    const dir = root();
    writeFileSync(join(outside, "secret.txt"), "outside");
    mkdirSync(join(dir, ".forge"));
    if (
      !tryLinkFile(
        join(outside, "secret.txt"),
        join(dir, ".forge", "config.yaml"),
      )
    )
      return;
    const files = nodeConfigFiles(dir);
    expect(() => files.read(".forge/config.yaml")).toThrow(
      /outside|symlink|root/i,
    );
    expect(() => files.write(".forge/config.yaml", bytes("pwn"))).toThrow(
      /outside|symlink|root/i,
    );
    expect(() =>
      files.createExclusive(".forge/config.yaml", bytes("pwn")),
    ).toThrow(/outside|symlink|root/i);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
  });

  test("a symlinked parent directory cannot carry reads, writes, removals or listings out", () => {
    const outside = root();
    const dir = root();
    writeFileSync(join(outside, "config.yaml"), "outside");
    linkDir(outside, join(dir, ".forge"));
    const files = nodeConfigFiles(dir);
    expect(() => files.read(".forge/config.yaml")).toThrow(
      /outside|symlink|root/i,
    );
    expect(() => files.write(".forge/config.yaml", bytes("pwn"))).toThrow(
      /outside|symlink|root/i,
    );
    expect(() =>
      files.write(".forge/deep/er/config.yaml", bytes("pwn")),
    ).toThrow(/outside|symlink|root/i);
    expect(() => files.remove(".forge/config.yaml")).toThrow(
      /outside|symlink|root/i,
    );
    expect(() => files.list(".forge")).toThrow(/outside|symlink|root/i);
    expect(() =>
      files.createExclusive(".forge/config.lock", bytes("x")),
    ).toThrow(/outside|symlink|root/i);
    expect(readdirSync(outside)).toEqual(["config.yaml"]);
    expect(readFileSync(join(outside, "config.yaml"), "utf8")).toBe("outside");
  });

  test("a dangling symlink — as a parent or as the file — is refused, not written through", () => {
    const outside = root();
    const dir = root();
    // dangling directory link: its target is removed after linking
    const gone = join(outside, "gone");
    mkdirSync(gone);
    linkDir(gone, join(dir, ".forge"));
    rmSync(gone, { recursive: true });
    const files = nodeConfigFiles(dir);
    expect(() => files.write(".forge/config.yaml", bytes("pwn"))).toThrow(
      /outside|symlink|root|dangling/i,
    );
    expect(() =>
      files.createExclusive(".forge/config.lock", bytes("x")),
    ).toThrow(/outside|symlink|root|dangling/i);
    expect(readdirSync(outside)).toEqual([]);
    // dangling file link pointing at a path outside the root that does not exist yet
    mkdirSync(join(dir, "cfg"));
    if (
      tryLinkFile(join(outside, "new.yaml"), join(dir, "cfg", "config.yaml"))
    ) {
      const cfg = nodeConfigFiles(dir);
      expect(() => cfg.write("cfg/config.yaml", bytes("pwn"))).toThrow(
        /outside|symlink|root|dangling/i,
      );
      expect(() =>
        cfg.createExclusive("cfg/config.yaml", bytes("pwn")),
      ).toThrow(/outside|symlink|root|dangling/i);
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  test("a symlink at the final component is not followed by remove", () => {
    const outside = root();
    const dir = root();
    writeFileSync(join(outside, "keep.txt"), "outside");
    mkdirSync(join(dir, "cfg"));
    if (
      !tryLinkFile(join(outside, "keep.txt"), join(dir, "cfg", "config.yaml"))
    )
      return;
    nodeConfigFiles(dir).remove("cfg/config.yaml");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside");
  });

  test("`..` traversal and absolute paths are refused", () => {
    const outside = root();
    const dir = root();
    writeFileSync(join(outside, "secret.txt"), "outside");
    const files = nodeConfigFiles(dir);
    for (const path of [
      "../secret.txt",
      ".forge/../../secret.txt",
      "..",
      join(outside, "secret.txt").replaceAll("\\", "/"),
      join(outside, "secret.txt"),
    ]) {
      expect(() => files.read(path)).toThrow(/outside|root|absolute/i);
      expect(() => files.write(path, bytes("pwn"))).toThrow(
        /outside|root|absolute/i,
      );
      expect(() => files.remove(path)).toThrow(/outside|root|absolute/i);
      expect(() => files.createExclusive(path, bytes("pwn"))).toThrow(
        /outside|root|absolute/i,
      );
    }
    expect(() => files.list("..")).toThrow(/outside|root|absolute/i);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
  });

  test("a link that stays inside the project root still works for directories", () => {
    const dir = root();
    mkdirSync(join(dir, "real"));
    linkDir(join(dir, "real"), join(dir, "alias"));
    const files = nodeConfigFiles(dir);
    files.write("alias/config.yaml", bytes("a: 1\n"));
    expect(text(files.read("real/config.yaml"))).toBe("a: 1\n");
    expect(files.list("alias")).toEqual(["config.yaml"]);
  });

  test("a write that fails leaves no temporary file behind", () => {
    const dir = root();
    const files = nodeConfigFiles(dir);
    mkdirSync(join(dir, "cfg", "config.yaml"), { recursive: true });
    expect(() => files.write("cfg/config.yaml", bytes("x"))).toThrow();
    expect(readdirSync(join(dir, "cfg"))).toEqual(["config.yaml"]);
  });
});
