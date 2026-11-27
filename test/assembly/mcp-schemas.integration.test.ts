import type { Tool } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { blockCapture } from "../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import {
  createAssembly,
  localContext,
  type Assembly,
} from "../../src/assembly/index.ts";
import { assemblyMcp } from "../../src/assembly/mcp.ts";
import { relay } from "../fixtures/owner-approval.ts";

setDefaultTimeout(30_000);

const operations = ["sample.array", "sample.scalar"];
const exampleInput = { text: "abcdef", at: "2026-07-28T00:00:00Z" };
const workOps = ["issue.create", "issue.claim", "issue.show"];

function writeBlock(root: string) {
  const write = (path: string, value: unknown) =>
    writeFileSync(join(root, "sample", path), JSON.stringify(value));
  mkdirSync(join(root, "sample", "schemas", "nested"), { recursive: true });
  write("forge.block.json", {
    schemaVersion: "forge.block/1",
    id: "example.org/sample",
    version: "1.0.0",
    authorAbi: "forge.author/v2",
    profile: "trusted-action/v2",
    entry: "entry.cjs",
    docs: "docs.json",
    files: ["schemas/nested/text.json", "schemas/limits.json"],
    operations: Object.fromEntries(
      operations.map((op) => [
        op,
        {
          input: "schemas/input.json",
          output: `schemas/${op.split(".")[1]}.json`,
          context: "stateless",
          effects: [],
          idempotent: true,
          callers: ["agent", "human"],
          stability: "stable",
          timeoutMs: 1000,
        },
      ]),
    ),
  });
  write("docs.json", {
    operations: Object.fromEntries(
      operations.map((op) => [op, { title: op, summary: "Return text." }]),
    ),
  });
  write("schemas/input.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["text", "at"],
    properties: {
      text: {
        $ref: "nested/text.json#/$defs/Text~1~0",
        minLength: 4,
        maxLength: 9,
      },
      at: {
        $ref: "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/common.json#/$defs/Timestamp",
      },
    },
    additionalProperties: false,
  });
  write("schemas/nested/text.json", {
    $defs: { "Text/~": { $ref: "../limits.json#/$defs/Minimum" } },
  });
  write("schemas/limits.json", {
    $defs: {
      Minimum: { $ref: "#/$defs/Text~1~0", minLength: 6 },
      "Text/~": { type: "string" },
    },
  });
  write("schemas/scalar.json", { $ref: "limits.json#/$defs/Minimum" });
  write("schemas/array.json", {
    type: "array",
    items: { $ref: "scalar.json" },
  });
  writeFileSync(
    join(root, "sample", "entry.cjs"),
    `module.exports = {
    "sample.array": ({ input }) => [input.text],
    "sample.scalar": ({ input }) => input.text,
  };`,
  );
}

interface Reply {
  id: number;
  result?: { tools?: Tool[]; structuredContent?: unknown };
  error?: { message: string };
}

async function withWire(
  assembly: Assembly,
  era: string,
  run: (
    rpc: (method: string, params?: object) => Promise<Reply>,
  ) => Promise<void>,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const clientInfo = { name: "schema-fixture", version: "1.0.0" };
  const capabilities = {};
  const modern = era === "2026-07-28";
  const meta = {
    "io.modelcontextprotocol/protocolVersion": era,
    "io.modelcontextprotocol/clientInfo": clientInfo,
    "io.modelcontextprotocol/clientCapabilities": capabilities,
  };
  const opened = await assemblyMcp(assembly).open({
    serverName: clientInfo.name,
    serverVersion: clientInfo.version,
    handlers: {
      listTools: () => [],
      callTool: () => Promise.resolve(undefined),
    },
    input: Readable.toWeb(input),
    output: Writable.toWeb(output),
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  let id = 0;
  const rpc = async (method: string, params: object = {}) => {
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: modern ? { ...params, _meta: meta } : params,
      })}\n`,
    );
    const reply = await replies.next();
    if (reply.done) throw new Error(`MCP closed before answering ${method}`);
    const message = JSON.parse(reply.value) as Reply;
    expect(message.id).toBe(id);
    expect(message.error).toBeUndefined();
    return message;
  };
  try {
    await rpc(
      modern ? "server/discover" : "initialize",
      modern
        ? {}
        : {
            protocolVersion: era,
            clientInfo,
            capabilities,
          },
    );
    if (!modern)
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await run(rpc);
  } finally {
    lines.close();
    await opened.handle.close();
    input.end();
    output.end();
  }
}

function compile(schema: object | undefined) {
  if (schema === undefined) throw new Error("Missing tool schema");
  return new AjvJsonSchemaValidator().getValidator(schema);
}

for (const era of ["2025-11-25", "2026-07-28"]) {
  test(`MCP ${era} tool schemas compile offline and validate actual successes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-mcp-schema-"));
    mkdirSync(join(root, ".forge"));
    writeBlock(root);
    writeFileSync(
      join(root, ".forge", "config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: {
          work: { source: { builtin: "forge/work" } },
          sample: { source: { path: "./sample" } },
        },
        mcp: { expose: [...workOps, ...operations, "config.show"] },
      }),
    );
    const source = fileURLToPath(firstPartyBlocks["forge/work"]!);
    const built = fileURLToPath(
      new URL("../../dist/src/blocks/work/", import.meta.url),
    );
    const open = blockCapture.open.bind(blockCapture);
    const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
      open(path === source ? built : path),
    );
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
      providers: { env: {} },
    });
    try {
      let requestId = 0;
      const invoke = (op: string, input: unknown) =>
        assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: `admit-${++requestId}`,
          op,
          input,
          caller: "human",
          context: localContext(
            assembly,
            { kind: "human", id: "fixture" },
            "fixture",
          ),
        });
      const checked = await invoke("block.check", { path: "./sample" });
      expect(checked).toMatchObject({ ok: true });
      if (!checked.ok) throw new Error(JSON.stringify(checked));
      const { digest } = checked.result as { digest: string };
      const admitted = await relay(invoke, "block.admit", { digest });
      expect(admitted).toMatchObject({ ok: true });
      await withWire(assembly, era, async (rpc) => {
        const tools = (await rpc("tools/list")).result?.tools ?? [];
        const call = async (name: string, args: object) =>
          (await rpc("tools/call", { name, arguments: args })).result
            ?.structuredContent;
        const createInput = { title: "Test schema discovery" };
        const created = (await call("issue_create", createInput)) as {
          result?: { id: string };
        };
        expect(created).toMatchObject({ ok: true });
        expect(typeof created.result?.id).toBe("string");
        const issueInput = { id: created.result!.id };
        const dispatchInput = { op: "issue.show", input: issueInput };
        const cases = [
          ["issue_create", createInput, created],
          ["issue_claim", issueInput, await call("issue_claim", issueInput)],
          ["issue_show", issueInput, await call("issue_show", issueInput)],
          ["config_show", {}, await call("config_show", {})],
          [
            "sample_array",
            exampleInput,
            await call("sample_array", exampleInput),
          ],
          [
            "sample_scalar",
            exampleInput,
            await call("sample_scalar", exampleInput),
          ],
          [
            "catalog_call",
            {
              schemaVersion: "forge.invocation/1",
              requestId: "offline-dispatch",
              caller: "agent",
              context: {},
              ...dispatchInput,
            },
            await call("catalog_call", dispatchInput),
          ],
        ] as const;
        for (const [name, , envelope] of cases) {
          expect(envelope, name).toMatchObject({ ok: true, status: "OK" });
          expect(tools.map((tool) => tool.name)).toContain(name);
        }
        expect(cases[4][2]).toMatchObject({ result: ["abcdef"] });
        expect(cases[5][2]).toMatchObject({ result: "abcdef" });
        const failures: string[] = [];
        for (const tool of tools) {
          for (const side of ["inputSchema", "outputSchema"] as const) {
            try {
              compile(tool[side]);
            } catch (error) {
              failures.push(`${tool.name} ${side}: ${String(error)}`);
            }
          }
        }
        expect(failures).toEqual([]);
        for (const [name, args, envelope] of cases) {
          const tool = tools.find((entry) => entry.name === name)!;
          expect(compile(tool.inputSchema)(args), name).toMatchObject({
            valid: true,
          });
          expect(compile(tool.outputSchema)(envelope), name).toMatchObject({
            valid: true,
          });
        }
        const customInput = compile(
          tools.find((tool) => tool.name === "sample_scalar")?.inputSchema,
        );
        for (const text of ["abcde", "abcdefghij"]) {
          const args = { ...exampleInput, text };
          expect(await call("sample_scalar", args)).toMatchObject({
            ok: false,
            error: { code: "INPUT_INVALID" },
          });
          expect(customInput(args)).toMatchObject({ valid: false });
        }
      });
    } finally {
      capture.mockRestore();
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
