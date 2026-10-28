import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeBlockCatalog } from "../../../src/adapters/node-runtime/catalog.ts";
import { TrustStore, type TrustRecord } from "../../../src/core/trust/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";

for (const blockName of ["sample", "a".repeat(41)])
  test(`CLI captures, checks, admits exact bytes and runs (${blockName}); MCP cannot admit`, async () => {
    const root = mkdtempSync(join(tmpdir(), "block-dispatch-"));
    const blockId = `example.org/${blockName}`;
    try {
      const dir = join(root, "node_modules", "fixture-block");
      mkdirSync(dir, { recursive: true });
      const manifest = {
        schemaVersion: "forge.block/1",
        id: blockId,
        version: "1.0.0",
        authorAbi: "forge.author/v1",
        profile: "trusted-action-sync/v1",
        entry: "index.cjs",
        docs: "docs.json",
        operations: {
          "sample.run": {
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
      };
      writeFileSync(join(dir, "block.json"), JSON.stringify(manifest));
      writeFileSync(join(dir, "input.json"), '{"type":"string"}');
      writeFileSync(join(dir, "output.json"), '{"type":"string"}');
      writeFileSync(
        join(dir, "docs.json"),
        JSON.stringify({
          operations: {
            "sample.run": {
              title: "Authored title",
              summary: "Authored summary",
              description: "Authored description",
              examples: [{ input: "hello", output: "hello" }],
            },
          },
        }),
      );
      writeFileSync(
        join(dir, "index.cjs"),
        "module.exports = { 'sample.run': ({input}) => input };",
      );
      const records = new Map<string, TrustRecord>();
      const trust = new TrustStore(records);
      const catalog = createNodeBlockCatalog(root, trust);
      const cli = async (args: string[], human = false) =>
        (
          await runCli(catalog, args, {
            caller: human ? "human" : "agent",
            context: {
              actor: { kind: "human", id: "owner" },
              device: { id: "local" },
            },
          })
        ).envelope;
      assert.partialDeepStrictEqual(await cli(["block", "check", dir]), {
        ok: true,
        result: { admitted: false, blockId: blockId },
      });
      assert.equal(catalog.list().length, 0);
      assert.partialDeepStrictEqual(
        await cli(["block", "add", dir, "--dry-run"]),
        { ok: false, error: { code: "UNAVAILABLE" } },
      );
      assert.equal(catalog.list().length, 0);
      const added = await cli(["block", "add", "fixture-block"]);
      assert.partialDeepStrictEqual(added, {
        ok: true,
        result: { admitted: false, blockId: blockId },
      });
      assert.ok(added.ok);
      const digest = (added.result as { digest: string }).digest;
      assert.partialDeepStrictEqual(catalog.list(), [
        { op: "sample.run", admitted: false },
      ]);
      assert.partialDeepStrictEqual(
        await cli(["sample", "run", "--input", '"hello"']),
        { ok: false, error: { code: "ADMISSION_REQUIRED" } },
      );
      const mcp = createMcpHandlers(catalog);
      assert.partialDeepStrictEqual(
        await mcp.callTool("catalog_call", {
          op: "sample.run",
          input: "hello",
        }),
        { ok: false, error: { code: "ADMISSION_REQUIRED" } },
      );
      assert.ok(!mcp.listTools().some((t) => t.name === "block_admit"));
      assert.partialDeepStrictEqual(
        await mcp.callTool("catalog_call", {
          op: "block.admit",
          input: { digest },
          caller: "human",
        }),
        { ok: false, error: { code: "UNKNOWN_COMMAND" } },
      );
      assert.partialDeepStrictEqual(
        await cli(["block", "admit", digest, "--dry-run"], true),
        { ok: false, error: { code: "UNAVAILABLE" } },
      );
      assert.equal(catalog.list()[0]?.admitted, false);
      assert.partialDeepStrictEqual(
        (await runCli(catalog, ["block", "admit", digest], { caller: "human" }))
          .envelope,
        { ok: false, error: { code: "CONTEXT_MISSING" } },
      );
      assert.partialDeepStrictEqual(
        await cli(["block", "admit", digest], true),
        {
          ok: true,
          result: { digest, admitted: true },
        },
      );
      assert.partialDeepStrictEqual(
        await cli(["sample", "run", "--input", '"hello"']),
        { ok: true, result: "hello" },
      );
      assert.partialDeepStrictEqual(await cli(["block", "add", dir]), {
        ok: true,
        result: { admitted: true },
      });
      assert.partialDeepStrictEqual(
        await createMcpHandlers(catalog).callTool("sample_run", "hello"),
        { ok: true, result: "hello" },
      );
      assert.equal(catalog.list()[0]?.docs.title, "Authored title");
      const described = await cli(["catalog", "describe", "sample.run"]);
      assert.partialDeepStrictEqual(described, {
        ok: true,
        result: {
          docs: {
            title: "Authored title",
            description: "Authored description",
            examples: [{ input: "hello", output: "hello" }],
          },
        },
      });
      assert.equal(
        createMcpHandlers(catalog)
          .listTools()
          .find((tool) => tool.name === "sample_run")?.title,
        "Authored title",
      );
      const reused = createNodeBlockCatalog(root, new TrustStore(records));
      assert.partialDeepStrictEqual(
        (await runCli(reused, ["block", "add", dir])).envelope,
        { ok: true, result: { admitted: true } },
      );
      writeFileSync(
        join(dir, "index.cjs"),
        "module.exports = { 'sample.run': ({input}) => input }; ",
      );
      assert.partialDeepStrictEqual(
        await cli(["block", "admit", digest], true),
        {
          ok: false,
          error: { code: "INPUT_CONFLICT" },
        },
      );
      writeFileSync(join(dir, "input.json"), '{"$ref":"missing.json"}');
      const badSchema = await cli(["block", "check", dir]);
      assert.equal(badSchema.ok, false);
      assert.ok(!badSchema.ok && badSchema.error.message.length > 0);
      writeFileSync(join(dir, "input.json"), '{"type":"string"}');
      writeFileSync(
        join(dir, "block.json"),
        JSON.stringify({
          ...manifest,
          operations: {
            "sample.run": {
              ...manifest.operations["sample.run"],
              context: "invalid",
            },
          },
        }),
      );
      assert.partialDeepStrictEqual(await cli(["block", "check", dir]), {
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      writeFileSync(join(dir, "block.json"), JSON.stringify(manifest));
      writeFileSync(join(dir, "docs.json"), "{}");
      assert.partialDeepStrictEqual(await cli(["block", "check", dir]), {
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      writeFileSync(join(dir, "docs.json"), '{"operations":{}}');
      assert.partialDeepStrictEqual(await cli(["block", "check", dir]), {
        ok: false,
        error: {
          code: "INPUT_INVALID",
          message: "missing docs for sample.run",
        },
      });
      writeFileSync(join(dir, "block.json"), "{}");
      assert.partialDeepStrictEqual(await cli(["block", "check", dir]), {
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
