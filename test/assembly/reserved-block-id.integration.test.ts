import { relay } from "../fixtures/owner-approval.ts";
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { blockCapture } from "../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { record } from "../../src/surface/dispatch.ts";
import { done, stageBlock } from "../blocks/memory/lib.ts";
setDefaultTimeout(30_000);
const PATH_TEXT = "path block note";
const BUILTIN_TEXT = "built-in memory note";
const OWN_TEXT = "own id namespace note";
const OWN_ID = "example.org/hello";
const example = resolve(import.meta.dirname, "../../examples/hello-block");
const ENTRY = `module.exports={"hello.say":({input,services})=>({message:services.state.get(input.name)?.value?.text??""})}`;
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-reserved-id-"));
  const deviceRoot = join(root, "device");
  const staged = stageBlock("memory", join(root, "staged"));
  const own = join(root, "own");
  cpSync(example, own, { recursive: true });
  const manifestPath = join(own, "forge.block.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    requires?: unknown[];
    operations: Record<string, { context?: string }>;
  };
  manifest.requires = [{ slot: "state", interface: "forge.state@1" }];
  for (const operation of Object.values(manifest.operations))
    operation.context = "device";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(own, "index.cjs"), ENTRY);
  const seeded = LocalState.deviceRecords(deviceRoot);
  const owner = await seeded.open(true);
  if (!owner) throw new Error("device state did not open");
  owner.put(
    OWN_ID,
    "seed",
    { text: OWN_TEXT },
    { kind: "human", id: "test" },
    { expectRevision: 0 },
  );
  await seeded.close();
  const source = fileURLToPath(firstPartyBlocks["forge/memory"]!);
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(path === source ? staged : path),
  );
  const assembly = await createAssembly({ root, deviceRoot });
  let requests = 0;
  const call = (op: string, input: unknown = {}) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `reserved-${++requests}`,
      op,
      input,
      caller: "human",
      context: localContext(assembly, { kind: "human", id: "test" }),
    });
  return {
    call,
    async close() {
      await assembly.close();
      capture.mockRestore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("same-id path block state is separate from built-in state", async () => {
  const f = await fixture();
  const value = async (op: string, input: unknown = {}) =>
    record(done(await f.call(op, input)));
  const addAdmitted = async (path: string, blockId: string) => {
    const added = await f.call("block.add", { path });
    expect(done(added)).toMatchObject({ blockId, admitted: false });
    const digest = record(done(added))?.digest;
    expect(done(await relay(f.call, "block.admit", { digest }))).toMatchObject({
      admitted: true,
    });
    return digest;
  };
  try {
    const digest = await addAdmitted("./staged/memory", "forge/memory");
    done(
      await relay(f.call, "config.grant", {
        digest,
        effects: ["memory:write"],
      }),
    );
    done(
      await f.call("config.apply", {
        expectRevision: (await value("config.show"))?.revision,
        patch: [
          {
            op: "set",
            path: "/blocks/memory/rename",
            value: { memory: "probe", decision: "choices" },
          },
          {
            op: "set",
            path: "/blocks/real",
            value: { source: { builtin: "forge/memory" } },
          },
        ],
      }),
    );
    const input = (text: string) => ({ text, level: "device" });
    const added = { status: "added", id: "device/note-1" };
    const note = (text: string) => ({ note: { text: { text } } });
    expect(await value("probe.add", input(PATH_TEXT))).toMatchObject(added);
    expect(await value("memory.add", input(BUILTIN_TEXT))).toMatchObject(added);
    expect(await value("probe.show", { id: "device/note-2" })).toMatchObject({
      status: "not_found",
    });
    expect(await value("memory.show", { id: "device/note-1" })).toMatchObject(
      note(BUILTIN_TEXT),
    );
    expect(await value("probe.show", { id: "device/note-1" })).toMatchObject(
      note(PATH_TEXT),
    );
    await addAdmitted("./own", OWN_ID);
    expect(await value("hello.say", { name: "seed" })).toEqual({
      message: OWN_TEXT,
    });
  } finally {
    await f.close();
  }
});
