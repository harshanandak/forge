import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { blockCapture } from "../../src/assembly/capture.ts";
import { createAssembly, localContext } from "../../src/assembly/index.ts";

setDefaultTimeout(30_000);

const example = resolve(import.meta.dirname, "../../examples/hello-block");

async function fixture(kind: "plain" | "internal" | "outside" | "parent") {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-block-root-"));
  const root = join(sandbox, "project");
  const outside = join(sandbox, "project-other");
  let assembly: Awaited<ReturnType<typeof createAssembly>> | undefined;
  const capture = spyOn(blockCapture, "open");
  try {
    mkdirSync(join(root, ".forge"), { recursive: true });
    const target =
      kind === "outside" || kind === "parent"
        ? join(outside, "sample")
        : join(root, "real", "sample");
    cpSync(example, target, { recursive: true });
    let path = "./real/sample";
    if (kind === "parent") {
      symlinkSync(outside, join(root, "alias"), "junction");
      path = "./alias/sample";
    } else if (kind !== "plain") {
      symlinkSync(target, join(root, "alias"), "junction");
      path = "./alias";
    }
    const config = join(root, ".forge/config.yaml");
    const configure = (enabled: boolean) =>
      writeFileSync(
        config,
        JSON.stringify({
          schemaVersion: "forge.config/1",
          blocks: enabled ? { sample: { source: { path } } } : {},
        }),
      );
    configure(false);
    assembly = await createAssembly({
      root,
      deviceRoot: join(sandbox, "device"),
      providers: { env: {} },
    });
    const owned = assembly;
    return {
      assembly: owned,
      capture,
      config,
      configure,
      path,
      target: realpathSync.native(target),
      call: (op: string, input: unknown = {}) =>
        owned.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: op,
          op,
          input,
          caller: "human",
          context: localContext(owned, { kind: "human", id: "test" }),
        }),
      async close() {
        capture.mockRestore();
        await owned.close();
        rmSync(sandbox, { recursive: true, force: true });
      },
    };
  } catch (error) {
    capture.mockRestore();
    await assembly?.close();
    rmSync(sandbox, { recursive: true, force: true });
    throw error;
  }
}

test("a configured missing folder retains capture's PROVIDER_MISSING error", async () => {
  const f = await fixture("plain");
  try {
    f.configure(true);
    rmSync(f.target, { recursive: true });
    f.capture.mockClear();
    expect(await f.call("config.show")).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
      result: { valid: false },
    });
    expect(f.assembly.catalog.unavailable()).toMatchObject([
      { name: "sample", error: { code: "PROVIDER_MISSING" } },
    ]);
    // The folder is missing, so canonicalize its existing parent on both sides.
    const nativeParent = (path: string) =>
      join(realpathSync.native(dirname(path)), basename(path));
    expect(f.capture.mock.calls.map(([root]) => nativeParent(root))).toContain(
      nativeParent(f.target),
    );
  } finally {
    await f.close();
  }
});

for (const kind of ["outside", "parent"] as const) {
  test(`configured ${kind} link is refused before capture, including declaration probes`, async () => {
    const f = await fixture(kind);
    try {
      f.configure(true);
      f.capture.mockClear();
      const shown = await f.call("config.show");
      expect(shown).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
        result: { valid: false },
      });
      const unavailable = f.assembly.catalog.unavailable();
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]).toMatchObject({
        name: "sample",
        error: { code: "INPUT_INVALID" },
      });
      expect(unavailable[0]!.reason).toContain(f.path);
      expect(unavailable[0]!.reason).toContain("resolves outside the project");
      expect(unavailable[0]!.reason).not.toContain(f.target);
      expect((await f.call("hello.say", { name: "World" })).ok).toBe(false);
      expect(
        f.capture.mock.calls.map(([root]) => realpathSync.native(root)),
      ).not.toContain(f.target);
    } finally {
      await f.close();
    }
  });

  test(`block.add refuses an ${kind} link without capture or config changes`, async () => {
    const f = await fixture(kind);
    try {
      const before = readFileSync(f.config);
      f.capture.mockClear();
      const added = await f.call("block.add", { path: f.path });
      expect(added).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      expect(readFileSync(f.config)).toEqual(before);
      expect(
        f.capture.mock.calls.map(([root]) => realpathSync.native(root)),
      ).not.toContain(f.target);
      // An explicit check has the caller's authority to inspect this folder.
      expect(await f.call("block.check", { path: f.path })).toMatchObject({
        ok: true,
        result: { blockId: "example.org/hello" },
      });
    } finally {
      await f.close();
    }
  });
}

for (const kind of ["plain", "internal"] as const) {
  test(`configured ${kind} source and block.add still capture an in-project block`, async () => {
    const f = await fixture(kind);
    try {
      f.configure(true);
      f.capture.mockClear();
      expect(await f.call("config.show")).toMatchObject({
        ok: true,
        result: { valid: true },
      });
      expect(f.assembly.catalog.unavailable()).toEqual([]);
      // Configured sources reach capture with the canonical folder identity.
      expect(f.capture.mock.calls.map(([root]) => root)).toContain(f.target);
      f.configure(false);
      expect(await f.call("block.add", { path: f.path })).toMatchObject({
        ok: true,
        result: { blockId: "example.org/hello" },
      });
      expect(readFileSync(f.config, "utf8")).toContain(f.path);
    } finally {
      await f.close();
    }
  });
}
