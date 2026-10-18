import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { CapturedBlock } from "../../../src/core/catalog/index.ts";
import { operations } from "../../../src/core/catalog/operations.ts";
import type { SurfaceCatalog } from "../../../src/surface/catalog.ts";
import type { BlockManifest } from "../../../src/generated/types.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { SchemaRegistry } from "../../../src/contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../../src/generated/schemas.ts";
import { discoveryOperations } from "../../../src/surface/discovery.ts";

for (const name of ["catalog_list", "catalog_describe", "catalog_call"])
  test(`${name} results validate against the advertised MCP output schema`, async () => {
    const catalog: SurfaceCatalog = {
      list: () => [{ ...discoveryOperations[0]!, op: "sample.run" }],
      invoke: (request) =>
        Promise.resolve({
          ok: true,
          op: request.op,
          status: "OK",
          result: "hello",
          warnings: [],
        }),
    };
    const handlers = createMcpHandlers(catalog);
    const tool = handlers.listTools().find((tool) => tool.name === name)!;
    const id = "https://test.invalid/output.json";
    const registry = new SchemaRegistry([
      ...SCHEMA_DOCUMENTS,
      { ...tool.outputSchema, $id: id },
    ]);
    const input =
      name === "catalog_call"
        ? {
            schemaVersion: "forge.invocation/1",
            requestId: "schema-test",
            op: "sample.run",
            input: "hello",
            caller: "agent",
            context: {},
          }
        : { op: "sample.run" };
    const result = await handlers.callTool(name, input);
    assert.ok(result?.ok);
    assert.deepEqual(registry.validate(id, result), []);
    assert.notDeepEqual(
      registry.validate(
        id,
        name === "catalog_call"
          ? { ...result, status: "INVALID" }
          : { ...result, result: 42 },
      ),
      [],
    );
    if (name !== "catalog_list") {
      const failure = await handlers.callTool(name, {
        ...input,
        op: "missing.run",
      });
      assert.equal(failure?.ok, false);
      assert.deepEqual(registry.validate(id, failure), []);
    }
  }, 5000);

test("an added area declaration reaches help, MCP and catalog dispatch after generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-discovery-"));
  try {
    for (const dir of ["src", "tools", "schemas"])
      cpSync(new URL(`../../../${dir}`, import.meta.url), join(root, dir), {
        recursive: true,
      });
    const fragment = join(root, "src/core/catalog/operations.ts");
    writeFileSync(
      fragment,
      readFileSync(fragment, "utf8") +
        '\noperations["catalog.probe"] = operations["catalog.list"]!;\n',
    );
    const generated = spawnSync(
      process.execPath,
      [join(root, "tools/gen/types.ts")],
      { cwd: root, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const { runCli } = (await import(
      pathToFileURL(join(root, "src/surface/cli.ts")).href
    )) as typeof import("../../../src/surface/cli.ts");
    const { createMcpHandlers } = (await import(
      pathToFileURL(join(root, "src/surface/mcp.ts")).href
    )) as typeof import("../../../src/surface/mcp.ts");
    const calls: string[] = [];
    const catalog: SurfaceCatalog = {
      list: () => [],
      invoke: (request) => {
        calls.push(request.op);
        return Promise.resolve({
          ok: true,
          op: request.op,
          status: "OK",
          result: [],
          warnings: [],
        });
      },
    };
    const help = (await runCli(catalog, ["--help"])).envelope;
    assert.ok(help.ok);
    const entries = (
      help.result as {
        operations: {
          op: string;
          declaration: unknown;
          inputSchema: unknown;
        }[];
      }
    ).operations;
    assert.ok(entries.some((entry) => entry.op === "catalog.probe"));
    assert.deepEqual(
      entries.find((entry) => entry.op === "catalog.call")?.declaration,
      operations["catalog.call"],
    );
    assert.deepEqual(
      entries.find((entry) => entry.op === "catalog.call")?.inputSchema,
      JSON.parse(
        readFileSync(
          new URL(
            "../../../src/core/catalog/call.input.schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    assert.ok(!entries.some((entry) => entry.op === "block.admit"));
    const handlers = createMcpHandlers(catalog);
    assert.ok(
      handlers.listTools().some((tool) => tool.name === "catalog_probe"),
    );
    assert.ok(
      !handlers.listTools().some((tool) => tool.name === "block_admit"),
    );
    assert.equal(
      handlers.listTools().find((tool) => tool.name === "catalog_list")
        ?.outputSchema?.type,
      "object",
    );
    assert.equal(
      handlers.listTools().find((tool) => tool.name === "catalog_call")
        ?.annotations.readOnlyHint,
      false,
    );
    const listed = await handlers.callTool("catalog_list", {});
    assert.ok(listed?.ok);
    assert.ok(
      (listed.result as { op: string }[]).some(
        (entry) => entry.op === "catalog.probe",
      ),
    );
    assert.equal((await runCli(catalog, ["catalog.probe"])).envelope.ok, true);
    assert.equal((await handlers.callTool("catalog_probe", {}))?.ok, true);
    assert.deepEqual(calls, ["catalog.probe", "catalog.probe"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("captured schema filenames preserve reserved characters and separate reference fragments", () => {
  const manifest: BlockManifest = {
    schemaVersion: "forge.block/1",
    id: "example.org/sample",
    version: "1.0.0",
    authorAbi: "forge.author/v1",
    profile: "trusted-action-sync/v1",
    entry: "index.cjs",
    docs: "docs.json",
    operations: {
      "sample.run": {
        ...operations["catalog.list"]!,
        input: "schemas/a#b.json",
        output: "schemas/a%23b?.json",
      },
    },
  };
  const block = new CapturedBlock(
    new Map([
      [
        "schemas/a#b.json",
        JSON.stringify({ $ref: "defs%23part.json#/$defs/value" }),
      ],
      [
        "schemas/defs#part.json",
        JSON.stringify({
          $defs: { value: { type: "string", const: "full filename" } },
        }),
      ],
      ["schemas/a%23b?.json", JSON.stringify({ type: "number" })],
    ]),
    manifest,
  );
  assert.equal(block.validate("schemas/a#b.json", "full filename"), true);
  assert.equal(block.validate("schemas/a#b.json", "wrong"), false);
  assert.equal(block.validate("schemas/a%23b?.json", 42), true);
  assert.equal(block.validate("schemas/a%23b?.json", "wrong"), false);
}, 5000);
