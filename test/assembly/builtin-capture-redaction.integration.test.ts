import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as cap from "../../src/adapters/node-runtime/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import * as asm from "../../src/assembly/index.ts";
import { exitCode } from "../../src/surface/result.ts";
setDefaultTimeout(30_000);
const example = resolve(import.meta.dirname, "../../examples/hello-block");
const builtins = firstPartyBlocks as Record<string, URL>;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function make(kind: "builtin" | "path", id = "forge/capture-test") {
  const sandbox = fs.mkdtempSync(join(tmpdir(), "forge-capture-"));
  const root = join(sandbox, "project");
  const block = join(sandbox, "block");
  fs.mkdirSync(join(root, ".forge"), { recursive: true });
  const source = kind === "builtin" ? `builtin: ${id}` : "path: ./block";
  fs.writeFileSync(
    join(root, ".forge/config.yaml"),
    `schemaVersion: forge.config/1\nblocks:\n  redacted:\n    source:\n      ${source}\n`,
  );
  if (kind === "builtin") {
    fs.cpSync(example, block, { recursive: true });
    builtins[id] = pathToFileURL(`${block}/`);
  }
  const assembly = await asm.createAssembly({
    root,
    deviceRoot: join(sandbox, "device"),
    providers: { env: {} },
  });
  const base = {
    schemaVersion: "forge.invocation/1" as const,
    input: {},
    caller: "human" as const,
    context: asm.localContext(assembly, { kind: "human", id: "test" }),
  };
  const invoke = (op: string) =>
    assembly.catalog.invoke({ ...base, requestId: op, op });
  cleanup.push(async () => {
    delete builtins[id];
    await assembly.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return { sandbox, root, block, assembly, invoke };
}
type F = Awaited<ReturnType<typeof make>>;
type U = asm.UnavailableBlock;
async function probe(f: F) {
  expect((await f.invoke("config.show")).ok).toBe(false);
  const unavailable = f.assembly.catalog.unavailable();
  expect(unavailable).toHaveLength(1);
  return unavailable[0]!;
}
function expectError(e: U, code: string, message: string) {
  const actual = [e.error.code, e.error.retry, e.error.message, e.reason];
  expect(actual).toEqual([code, "never", message, message]);
}
async function probeFixed(f: F, id: string, code: string) {
  const entry = await probe(f);
  const message = `built-in block ${id} could not be captured (${code})`;
  expectError(entry, code, message);
  return entry;
}
function corruptManifest(block: string, received: string) {
  const p = join(block, "forge.block.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  m.schemaVersion = received;
  fs.writeFileSync(p, JSON.stringify(m));
}
function expectPathFree(e: U, paths: readonly string[]) {
  const serialized = JSON.stringify(e);
  for (const path of new Set(paths)) {
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain(path.replaceAll("\\", "\\\\"));
  }
}
test("builtin capture race keeps INPUT_CONFLICT and exit 4 with a path-free fixed message", async () => {
  const id = "forge/race-capture-test";
  const f = await make("builtin", id);
  const mutate = () => fs.appendFileSync(`${f.block}/forge.block.json`, " ");
  const racing = cap.createNodeFileCapture(mutate);
  const open = spyOn(cap.nodeFileCapture, "open").mockImplementation(
    (rootPath: string) => racing.open(rootPath),
  );
  cleanup.push(() => open.mockRestore());
  const entry = await probeFixed(f, id, "INPUT_CONFLICT");
  expect(entry.name).toBe("redacted");
  expect(
    exitCode({ ok: false, status: "FAIL", error: entry.error, warnings: [] }),
  ).toBe(4);
  expectPathFree(entry, [f.block, fs.realpathSync.native(f.block)]);
});
test("missing built-in folder keeps PROVIDER_MISSING with a path-free fixed message", async () => {
  const id = "forge/missing-capture-test";
  const f = await make("builtin", id);
  const real = fs.realpathSync.native(f.block);
  fs.rmSync(f.block, { recursive: true, force: true });
  const entry = await probeFixed(f, id, "PROVIDER_MISSING");
  expectPathFree(entry, [f.block, real]);
});
test("malformed built-in manifest drops diagnostics holding the configured or real path", async () => {
  const id = "forge/malformed-capture-test";
  const f = await make("builtin", id);
  const real = fs.realpathSync.native(f.block);
  corruptManifest(f.block, real);
  const entry = await probeFixed(f, id, "INPUT_INVALID");
  expectPathFree(entry, [f.block, real]);
});
test.skipIf(process.platform === "win32")(
  "symlinked built-in root exposes neither the configured link nor its real path",
  async () => {
    const id = "forge/symlink-capture-test";
    const f = await make("builtin", id);
    const real = join(f.sandbox, "real-block");
    const linked = join(f.sandbox, "linked-block");
    fs.rmSync(f.block, { recursive: true, force: true });
    fs.cpSync(example, real, { recursive: true });
    fs.symlinkSync(real, linked, "dir");
    builtins[id] = pathToFileURL(`${linked}/`);
    corruptManifest(real, fs.realpathSync.native(real));
    const entry = await probeFixed(f, id, "INPUT_INVALID");
    expectPathFree(entry, [linked, real, fs.realpathSync.native(real)]);
  },
);
test("path source capture failure keeps the original message", async () => {
  const f = await make("path");
  const message = `synthetic missing block at ${resolve(f.root, "./block")}`;
  const open = spyOn(cap.nodeFileCapture, "open").mockImplementation(() => {
    throw new Error(message);
  });
  cleanup.push(() => open.mockRestore());
  expectError(await probe(f), "PROVIDER_MISSING", message);
});
