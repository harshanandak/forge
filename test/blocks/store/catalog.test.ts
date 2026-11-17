import { afterEach, expect, spyOn, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { createAssembly, type Assembly } from "../../../src/assembly/index.ts";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import type {
  AmbientContext,
  ResultEnvelope,
} from "../../../src/generated/types.ts";

interface Source {
  sha256: string;
  eventHighWaterMark: number;
  records: number;
  at: string;
  schemaVersion: string;
  tables: Record<string, number>;
  elapsedMs: number;
  forgeVersion: string;
}
const readSource = (out: string): Source =>
  JSON.parse(readFileSync(join(out, "source.json"), "utf8")) as Source;
const repo = resolve(import.meta.dirname, "../../..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface Open {
  readonly assembly: Assembly;
  readonly root: string;
  readonly ambient: AmbientContext;
  readonly close: () => Promise<void>;
}
let open: Open | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

function stage(into: string): string {
  const target = join(into, "store");
  cpSync(join(repo, "src/blocks/store"), target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  writeFileSync(
    join(target, "entry.cjs"),
    transpiler.transformSync(
      readFileSync(join(repo, "src/blocks/store/entry.cts"), "utf8"),
    ),
  );
  return target;
}

async function openStore(): Promise<Open> {
  const work = mkdtempSync(join(tmpdir(), "forge-store-block-"));
  const root = join(work, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { store: { source: { builtin: "forge/store" } } },
    }),
  );
  writeFileSync(
    join(root, ".forge", "project.json"),
    `${JSON.stringify({ schema: 1, id: "0d9f1c5e-3b7a-4c1e-9a52-6f4b8e2d7a10" })}\n`,
  );
  const seeded = await createSqliteStore(root).open({
    path: join(root, ".forge", "state.sqlite"),
    readOnly: false,
  });
  if (!seeded.ok) throw new Error(seeded.unavailable.reason);
  const owner = new StateOwner(seeded.handle.value, { now: () => 1000 });
  owner.initialize();
  owner.put(
    "forge/test",
    "key",
    { saved: true },
    { kind: "agent", id: "seed" },
    { expectRevision: 0, requestId: "seed" },
  );
  await seeded.handle.close();
  const staged = stage(join(work, "builtins"));
  const source = fileURLToPath(firstPartyBlocks["forge/store"]!);
  const original = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    original(path === source ? staged : path),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(work, "device"),
  });
  return {
    assembly,
    root,
    ambient: {
      actor: { kind: "human", id: "tester" },
      project: { id: assembly.root, root: assembly.root },
      device: { id: assembly.deviceRoot },
    },
    close: async () => {
      await assembly.close();
      capture.mockRestore();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

function call(
  o: Open,
  input: unknown,
  caller: "agent" | "human" = "human",
): Promise<ResultEnvelope> {
  return o.assembly.catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: "store-1",
    op: "store.export",
    input,
    caller,
    context: o.ambient,
  });
}

test("forge/store is a first-party source declared for a person only, so it is not an MCP tool", async () => {
  expect(Object.keys(firstPartyBlocks)).toContain("forge/store");
  open = await openStore();
  const entry = open.assembly.catalog
    .list()
    .find((candidate) => candidate.op === "store.export");
  expect(entry?.admitted).toBe(true);
  expect(entry?.declaration.callers).toEqual(["human"]);
  expect(entry?.declaration.context).toBe("project");
  const tools = createMcpHandlers(open.assembly.catalog, { budget: 100 })
    .listTools()
    .map((tool) => tool.name);
  expect(tools).not.toContain("store_export");
}, 60_000);

test("a person's export writes the backup and source.json for the project store", async () => {
  open = await openStore();
  const out = join(open.root, "backup");
  const envelope = await call(open, { out });
  expect(envelope.ok).toBe(true);
  const source = readSource(out);
  expect(source.sha256).toBe(
    createHash("sha256")
      .update(readFileSync(join(out, "backup.sqlite")))
      .digest("hex"),
  );
  expect(source.records).toBeGreaterThanOrEqual(1);
  expect(source.records).toBe(source.tables.state_records as number);
  expect(envelope.ok && envelope.result).toMatchObject({
    sha256: source.sha256,
    records: source.records,
  });
  const again = await call(open, { out });
  expect(again.ok).toBe(false);
}, 60_000);

test("an agent caller is refused and writes nothing", async () => {
  open = await openStore();
  const out = join(open.root, "agent-backup");
  const envelope = await call(open, { out }, "agent");
  expect(envelope.ok).toBe(false);
  expect(existsSync(out)).toBe(false);
}, 60_000);
