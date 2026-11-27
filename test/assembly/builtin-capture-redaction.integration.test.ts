import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  appendFileSync,
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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createNodeFileCapture,
  nodeFileCapture,
} from "../../src/adapters/node-runtime/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { exitCode } from "../../src/surface/result.ts";

setDefaultTimeout(30_000);

const example = resolve(import.meta.dirname, "../../examples/hello-block");
const fixed = (id: string, code: string) =>
  `built-in block ${id} could not be captured (${code})`;

async function assemble(sandbox: string, blocks: Record<string, unknown>) {
  const root = join(sandbox, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "config.yaml"),
    JSON.stringify({ schemaVersion: "forge.config/1", blocks }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(sandbox, "device"),
    providers: { env: {} },
  });
  const invoke = (op: string) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `capture-${op}`,
      op,
      input: {},
      caller: "human",
      context: localContext(assembly, { kind: "human", id: "test" }),
    });
  return {
    root,
    assembly,
    invoke,
    async close() {
      await assembly.close();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

async function builtinFixture(id: string) {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-builtin-capture-"));
  const blockDir = join(sandbox, "block");
  cpSync(example, blockDir, { recursive: true });
  (firstPartyBlocks as Record<string, URL>)[id] = pathToFileURL(blockDir + "/");
  const f = await assemble(sandbox, {
    redacted: { source: { builtin: id } },
  });
  return {
    ...f,
    sandbox,
    blockDir,
    async close() {
      delete (firstPartyBlocks as Record<string, URL>)[id];
      await f.close();
    },
  };
}

function corruptManifest(blockDir: string, received: string) {
  const file = join(blockDir, "forge.block.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  manifest.schemaVersion = received;
  writeFileSync(file, JSON.stringify(manifest));
}

function expectPathFree(serialized: string, paths: readonly string[]) {
  for (const path of new Set(paths)) {
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain(path.replaceAll("\\", "\\\\"));
  }
}

test("builtin capture race keeps INPUT_CONFLICT and exit 4 with a path-free fixed message", async () => {
  const id = "forge/race-capture-test";
  const f = await builtinFixture(id);
  const racing = createNodeFileCapture(() => {
    appendFileSync(join(f.blockDir, "forge.block.json"), " ");
  });
  const open = spyOn(nodeFileCapture, "open").mockImplementation(
    (rootPath: string) => racing.open(rootPath),
  );
  try {
    const reply = await f.invoke("config.show");
    expect(reply.ok).toBe(false);
    const unavailable = f.assembly.catalog.unavailable();
    expect(unavailable).toHaveLength(1);
    const entry = unavailable[0]!;
    const expected = fixed(id, "INPUT_CONFLICT");
    expect(entry.name).toBe("redacted");
    expect(entry.error.code).toBe("INPUT_CONFLICT");
    expect(entry.error.retry).toBe("never");
    expect(entry.error.message).toBe(expected);
    expect(entry.reason).toBe(expected);
    expect(
      exitCode({
        ok: false,
        status: "FAIL",
        error: entry.error,
        warnings: [],
      }),
    ).toBe(4);
    expectPathFree(JSON.stringify(entry), [
      f.blockDir,
      realpathSync.native(f.blockDir),
    ]);
  } finally {
    open.mockRestore();
    await f.close();
  }
});

test("missing built-in folder keeps PROVIDER_MISSING with a path-free fixed message", async () => {
  const id = "forge/missing-capture-test";
  const f = await builtinFixture(id);
  try {
    const configured = f.blockDir;
    const real = realpathSync.native(configured);
    rmSync(configured, { recursive: true, force: true });
    const reply = await f.invoke("config.show");
    expect(reply.ok).toBe(false);
    const unavailable = f.assembly.catalog.unavailable();
    expect(unavailable).toHaveLength(1);
    const entry = unavailable[0]!;
    const expected = fixed(id, "PROVIDER_MISSING");
    expect(entry.error.code).toBe("PROVIDER_MISSING");
    expect(entry.error.retry).toBe("never");
    expect(entry.error.message).toBe(expected);
    expect(entry.reason).toBe(expected);
    expectPathFree(JSON.stringify(entry), [configured, real]);
  } finally {
    await f.close();
  }
});

test("malformed built-in manifest drops diagnostics holding the configured or real path", async () => {
  const id = "forge/malformed-capture-test";
  const f = await builtinFixture(id);
  try {
    const configured = f.blockDir;
    const real = realpathSync.native(configured);
    corruptManifest(configured, real);
    const reply = await f.invoke("config.show");
    expect(reply.ok).toBe(false);
    const unavailable = f.assembly.catalog.unavailable();
    expect(unavailable).toHaveLength(1);
    const entry = unavailable[0]!;
    const expected = fixed(id, "INPUT_INVALID");
    expect(entry.error.code).toBe("INPUT_INVALID");
    expect(entry.error.retry).toBe("never");
    expect(entry.error.message).toBe(expected);
    expect(entry.reason).toBe(expected);
    expectPathFree(JSON.stringify(entry), [configured, real]);
  } finally {
    await f.close();
  }
});

test.skipIf(process.platform === "win32")(
  "symlinked built-in root exposes neither the configured link nor its real path",
  async () => {
    const id = "forge/symlink-capture-test";
    const f = await builtinFixture(id);
    try {
      const real = join(f.sandbox, "real-block");
      const linked = join(f.sandbox, "linked-block");
      rmSync(f.blockDir, { recursive: true, force: true });
      cpSync(example, real, { recursive: true });
      symlinkSync(real, linked, "dir");
      (firstPartyBlocks as Record<string, URL>)[id] = pathToFileURL(
        linked + "/",
      );
      corruptManifest(real, realpathSync.native(real));
      const reply = await f.invoke("config.show");
      expect(reply.ok).toBe(false);
      const unavailable = f.assembly.catalog.unavailable();
      expect(unavailable).toHaveLength(1);
      const entry = unavailable[0]!;
      expect(entry.error.code).toBe("INPUT_INVALID");
      expect(entry.error.message).toBe(fixed(id, "INPUT_INVALID"));
      expectPathFree(JSON.stringify(entry), [
        linked,
        real,
        realpathSync.native(real),
      ]);
    } finally {
      await f.close();
    }
  },
);

test("path source capture failure keeps the original message", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-path-capture-"));
  const f = await assemble(sandbox, {
    redacted: { source: { path: "./block" } },
  });
  const missing = resolve(f.root, "./block");
  const expected = `synthetic missing block at ${missing}`;
  const realOpen = nodeFileCapture.open.bind(nodeFileCapture);
  const open = spyOn(nodeFileCapture, "open").mockImplementation(
    (rootPath: string) => {
      if (rootPath === missing) throw new Error(expected);
      return realOpen(rootPath);
    },
  );
  try {
    expect(expected).toContain(missing);
    const reply = await f.invoke("config.show");
    expect(reply.ok).toBe(false);
    const unavailable = f.assembly.catalog.unavailable();
    expect(unavailable).toHaveLength(1);
    const entry = unavailable[0]!;
    expect(entry.error.code).toBe("PROVIDER_MISSING");
    expect(entry.error.retry).toBe("never");
    expect(entry.error.message).toBe(expected);
    expect(entry.reason).toBe(expected);
  } finally {
    open.mockRestore();
    await f.close();
  }
});
