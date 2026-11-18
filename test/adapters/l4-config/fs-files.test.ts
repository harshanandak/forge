// The ConfigFiles port: core config reaches the filesystem only through it, and the `fs` adapter is
// its Node implementation. The contract suite runs against that adapter.
import {
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import {
  linkSync,
  lstatSync,
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
import * as durableIO from "../../../src/adapters/fs/durable-io.ts";
import {
  nodeConfigFiles,
  restoreClaim,
} from "../../../src/adapters/fs/index.ts";

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
    files.write(".forge/notes/000002.json", bytes("{}"));
    files.write(".forge/notes/000001.json", bytes("{}"));
    expect(files.list(".forge/notes")).toEqual(["000001.json", "000002.json"]);
    files.remove(".forge/config.yaml", bytes("a: 2\n"));
    files.remove(".forge/config.yaml", bytes("a: 2\n"));
    expect(files.read(".forge/config.yaml")).toBeUndefined();
  });

  test("remove deletes only when the file still holds the bytes that were read", () => {
    const dir = root();
    const files = nodeConfigFiles(dir);
    files.write(".forge/cloud.json", bytes("project-a"));
    files.remove(".forge/cloud.json", bytes("project-a"));
    expect(files.read(".forge/cloud.json")).toBeUndefined();
    files.write(".forge/cloud.json", bytes("project-b"));
    expect(() => files.remove(".forge/cloud.json", bytes("project-a"))).toThrow(
      /changed since it was read/,
    );
    expect(text(files.read(".forge/cloud.json"))).toBe("project-b");
    expect(readdirSync(join(dir, ".forge"))).toEqual(["cloud.json"]);
    expect(() => files.remove(".forge/cloud.json", bytes("project-"))).toThrow(
      /changed since it was read/,
    );
    expect(text(files.read(".forge/cloud.json"))).toBe("project-b");
    files.remove(".forge/absent.json", bytes("project-a"));
  });

  test("a failure while comparing leaves the file at its path", () => {
    const dir = root();
    const files = nodeConfigFiles(dir);
    files.write(".forge/cloud.json", bytes("project-a"));
    const hostile = bytes("project-a");
    Object.defineProperty(hostile, "byteLength", {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => files.remove(".forge/cloud.json", hostile)).toThrow("boom");
    expect(text(files.read(".forge/cloud.json"))).toBe("project-a");
    expect(readdirSync(join(dir, ".forge"))).toEqual(["cloud.json"]);
  });

  test("a refused removal never leaves the path empty for another editor to take", () => {
    const files = nodeConfigFiles(root());
    files.write(".forge/config.lock", bytes("other-editor"));
    const mine = bytes("mine");
    const taken: boolean[] = [];
    Object.defineProperty(mine, "byteLength", {
      get() {
        taken.push(files.createExclusive(".forge/config.lock", bytes("third")));
        return 4;
      },
    });
    expect(() => files.remove(".forge/config.lock", mine)).toThrow(
      /changed since it was read/,
    );
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.every((won) => !won)).toBe(true);
    expect(text(files.read(".forge/config.lock"))).toBe("other-editor");
  }, 30_000);

  test("a same-content file swapped in after the read is not removed", () => {
    const dir = root();
    const files = nodeConfigFiles(dir);
    files.write(".forge/config.lock", bytes("held"));
    const expected = bytes("held");
    Object.defineProperty(expected, "byteLength", {
      get() {
        files.write(".forge/config.lock", bytes("held"));
        return 4;
      },
    });
    expect(() => files.remove(".forge/config.lock", expected)).toThrow(
      /changed since it was read/,
    );
    expect(text(files.read(".forge/config.lock"))).toBe("held");
    expect(readdirSync(join(dir, ".forge"))).toEqual(["config.lock"]);
  }, 30_000);

  test("restoring a claim keeps the original error when dropping the claim fails", () => {
    const dir = root();
    mkdirSync(join(dir, ".forge"));
    const claimed = join(dir, ".forge", ".config.lock.x.claim");
    const target = join(dir, ".forge", "config.lock");
    writeFileSync(claimed, "mine");
    const drop = spyOn(durableIO, "removeDurable").mockImplementation(() => {
      throw new Error("unlink failed");
    });
    try {
      expect(() =>
        restoreClaim(".forge/config.lock", target, claimed),
      ).not.toThrow();
    } finally {
      drop.mockRestore();
    }
    expect(readFileSync(target, "utf8")).toBe("mine");
  }, 30_000);

  test("a restore whose directory sync fails says the file is back at its path", () => {
    const dir = root();
    mkdirSync(join(dir, ".forge"));
    const claimed = join(dir, ".forge", ".config.lock.x.claim");
    const target = join(dir, ".forge", "config.lock");
    writeFileSync(claimed, "mine");
    const publish = spyOn(durableIO, "publishExclusive").mockImplementation(
      (from, to) => {
        linkSync(from, to);
        throw new Error("fsync failed");
      },
    );
    try {
      expect(() => restoreClaim(".forge/config.lock", target, claimed)).toThrow(
        /was put back.*could not be made durable/,
      );
    } finally {
      publish.mockRestore();
    }
    expect(readFileSync(target, "utf8")).toBe("mine");
  }, 30_000);

  test("createExclusive creates once and refuses while the file exists", () => {
    const files = nodeConfigFiles(root());
    expect(files.createExclusive(".forge/config.lock", bytes("one"))).toBe(
      true,
    );
    expect(files.createExclusive(".forge/config.lock", bytes("two"))).toBe(
      false,
    );
    expect(text(files.read(".forge/config.lock"))).toBe("one");
    files.remove(".forge/config.lock", bytes("one"));
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
    expect(() => files.remove(".forge/config.yaml", bytes("outside"))).toThrow(
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
    expect(() =>
      nodeConfigFiles(dir).remove("cfg/config.yaml", bytes("outside")),
    ).toThrow(/changed since it was read/);
    expect(lstatSync(join(dir, "cfg", "config.yaml")).isSymbolicLink()).toBe(
      true,
    );
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
      expect(() => files.remove(path, bytes("pwn"))).toThrow(
        /outside|root|absolute/i,
      );
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
