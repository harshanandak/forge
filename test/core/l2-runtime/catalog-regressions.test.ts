import { expect, test } from "bun:test";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import type { FileCapturePort } from "../../../src/core/catalog/index.ts";
import { BlockCatalog } from "../../../src/core/runtime/catalog.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { runCli } from "../../../src/surface/cli.ts";

const authoredDocs = {
  title: "Echo the author's message",
  summary: "Return the exact message supplied by the block's caller.",
  description: "This operation keeps the block author's documentation intact.",
  examples: [
    { input: { message: "hello-authored" }, output: "hello-authored" },
  ],
};

function fixture(blocks: readonly { id: string; noun: string }[]) {
  const roots = new Map(
    blocks.map(({ id, noun }) => [
      `./${noun}`,
      new Map(
        Object.entries({
          "block.json": JSON.stringify({
            schemaVersion: "forge.block/1",
            id,
            version: "1.0.0",
            authorAbi: "forge.author/v2",
            profile: "trusted-action/v2",
            entry: "index.cjs",
            docs: "docs.json",
            operations: {
              [`${noun}.run`]: {
                input: "input.json",
                output: "output.json",
                context: "stateless",
                timeoutMs: 1000,
                effects: [],
                idempotent: true,
                callers: ["human", "agent"],
                stability: "stable",
              },
            },
          }),
          "index.cjs": `module.exports = { '${noun}.run': ({input}) => input.message };`,
          "docs.json": JSON.stringify({
            operations: { [`${noun}.run`]: authoredDocs },
          }),
          "input.json": JSON.stringify({
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          }),
          "output.json": '{"type":"string"}',
        }),
      ),
    ]),
  );
  const capture: FileCapturePort = {
    open(root) {
      return {
        ownership: "borrowed",
        value: {
          read(name) {
            const text = roots.get(root)?.get(name);
            if (text === undefined) throw new Error(`missing ${root}/${name}`);
            return new TextEncoder().encode(text);
          },
        },
      };
    },
  };
  const trust = new TrustStore();
  const instances = new Map<string, string>();
  const catalog = new BlockCatalog(capture, trust, {
    isolation: nodeRunIsolation,
    services: (instance, _context, scope) => {
      instances.set(scope.op, instance);
      return Promise.resolve({ ownership: "borrowed", value: {} });
    },
  });
  const cli = (args: string[]) =>
    runCli(catalog, args, {
      caller: "human",
      context: {
        actor: { kind: "human", id: "owner" },
        device: { id: "local" },
      },
    });
  return {
    catalog,
    instances,
    cli,
    async add(noun: string) {
      const { envelope } = await cli(["block", "add", `./${noun}`]);
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) throw new Error(envelope.error.message);
      const { digest } = envelope.result as { digest: string };
      const admitted = await cli(["block", "admit", digest]);
      expect(admitted.envelope).toMatchObject({ ok: true });
    },
  };
}

test("captured authored operation docs reach the catalog and CLI help", async () => {
  const f = fixture([{ id: "example.org/sample", noun: "sample" }]);
  await f.add("sample");

  expect(f.catalog.list()[0]?.docs).toEqual(authoredDocs);
  expect(
    (await f.cli(["catalog", "describe", "sample.run"])).envelope,
  ).toMatchObject({ ok: true, result: { docs: authoredDocs } });
  expect(
    (await f.cli(["sample", "run", "--help", "--json"])).envelope,
  ).toMatchObject({
    ok: true,
    result: { operations: [{ op: "sample.run", docs: authoredDocs }] },
  });
  const help = await f.cli(["sample", "run", "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain(authoredDocs.summary);
  expect(help.stdout).toContain("hello-authored");
  expect(f.instances.size).toBe(0);
}, 10000);

test("long block IDs get valid, distinct default instance keys stable across runs and add order", async () => {
  const prefix = `${"a".repeat(22)}-${"b".repeat(17)}`;
  const blocks = [
    { id: `example.org/${prefix}x`, noun: "alpha" },
    { id: `example.org/${prefix}y`, noun: "beta" },
    { id: `example.net/${prefix}x`, noun: "gamma" },
  ];
  const runs: Map<string, string>[] = [];
  for (const order of [blocks, [...blocks].reverse()]) {
    const f = fixture(blocks);
    for (const { noun } of order) await f.add(noun);
    expect(f.catalog.list()).toHaveLength(blocks.length);
    for (const { id, noun } of blocks) {
      expect(
        f.catalog.list().find((entry) => entry.op === `${noun}.run`),
      ).toMatchObject({ blockId: id, admitted: true });
      expect(
        (
          await f.cli([
            noun,
            "run",
            "--input",
            JSON.stringify({ message: noun }),
          ])
        ).envelope,
      ).toMatchObject({ ok: true, result: noun });
      const key = f.instances.get(`${noun}.run`);
      expect(key).toBeDefined();
      expect(key).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(key!.length).toBeLessThanOrEqual(40);
    }
    expect(new Set(f.instances.values()).size).toBe(blocks.length);
    runs.push(f.instances);
  }
  expect(runs[1]).toEqual(runs[0]);
}, 10000);
