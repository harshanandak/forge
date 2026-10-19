import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly } from "../../../src/assembly/index.ts";
import type { AmbientContext } from "../../../src/generated/types.ts";

test("stateless file consumers acquire clone services only for declared file effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-stateless-files-"));
  const block = join(root, "block");
  mkdirSync(block);
  const effects = {
    pure: [],
    dishonest: [],
    read: ["files:read"],
  };
  const operations = Object.fromEntries(
    Object.entries(effects).map(([name, declared]) => [
      `sample.${name}`,
      {
        input: "input.json",
        output: "output.json",
        context: "stateless",
        effects: declared,
        idempotent: true,
        callers: ["agent", "human"],
        stability: "experimental",
        timeoutMs: 5000,
      },
    ]),
  );
  for (const [name, content] of Object.entries({
    "forge.block.json": JSON.stringify({
      schemaVersion: "forge.block/1",
      id: "example.org/sample",
      version: "1.0.0",
      authorAbi: "forge.author/v2",
      profile: "trusted-action/v2",
      entry: "entry.cjs",
      docs: "docs.json",
      requires: [{ slot: "files", interface: "forge.files@1" }],
      operations,
    }),
    "docs.json": JSON.stringify({
      operations: Object.fromEntries(
        Object.keys(operations).map((op) => [
          op,
          { title: op, summary: "Exercise per-operation file authority." },
        ]),
      ),
    }),
    "input.json": '{"type":"object","additionalProperties":false}',
    "output.json": "{}",
    "entry.cjs": `module.exports = {
      "sample.pure": async () => "pure",
      "sample.dishonest": async ({ services }) => services.files.read("input", 10),
      "sample.read": async ({ services }) => services.files.read("input", 10)
    };`,
  }))
    writeFileSync(join(block, name), content);
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  let sequence = 0;
  const call = (
    op: string,
    input: unknown = {},
    context: AmbientContext = {},
  ) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `stateless-files-${++sequence}`,
      op,
      input,
      caller: "human",
      context,
    });
  const configurationContext: AmbientContext = {
    actor: { kind: "human", id: "fixture" },
    project: { id: root, root },
    device: { id: join(root, "device") },
  };
  try {
    const shown = await call("config.show", {}, configurationContext);
    if (!shown.ok) throw new Error(shown.error.message);
    expect(
      await call(
        "config.apply",
        {
          expectRevision: (shown.result as { revision: string }).revision,
          patch: [
            {
              op: "set",
              path: "/blocks/sample",
              value: { source: { path: "./block" } },
            },
          ],
        },
        configurationContext,
      ),
    ).toMatchObject({ ok: true });
    const checked = await call(
      "block.check",
      { path: "./block" },
      configurationContext,
    );
    expect(checked).toMatchObject({ ok: true });
    if (!checked.ok) throw new Error(checked.error.message);
    const digest = (checked.result as { digest: string }).digest;
    expect(
      await call("block.admit", { digest }, configurationContext),
    ).toMatchObject({ ok: true });
    expect(await call("sample.pure")).toMatchObject({
      ok: true,
      result: "pure",
    });
    expect(await call("sample.dishonest")).toMatchObject({
      ok: false,
      error: { code: "EFFECT_UNDECLARED" },
    });
    expect(
      await call(
        "config.grant",
        { digest, effects: ["files:read"] },
        configurationContext,
      ),
    ).toMatchObject({ ok: true });
    expect(await call("sample.read")).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_MISSING" },
    });
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
