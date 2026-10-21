import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { captureBlock, Catalog } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import type { SurfaceCatalog } from "../../../src/surface/catalog.ts";
import type { OperationDocs } from "../../../src/generated/types.ts";
import { SchemaRegistry } from "../../../src/contract/schema.ts";
import { inputError } from "../../../src/contract/input-error.ts";
import { candidate, fakeCatalog } from "../../surface/fixtures/catalog.ts";

setDefaultTimeout(30_000);

function fixture() {
  const block = captureBlock(
    resolve(import.meta.dirname, "../../../src/blocks/work"),
    {
      open(root) {
        const handle = blockCapture.open(root);
        return {
          ownership: "borrowed",
          value: {
            read: (name, budget) =>
              name === "entry.cjs"
                ? new TextEncoder().encode("module.exports = {};")
                : handle.value.read(name, budget),
          },
        };
      },
    },
  );
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { work: { source: { path: "./work" } } },
    },
    new Map([["work", block]]),
  );
  const runtime = new Runtime(catalog, new TrustStore());
  const docs = (
    JSON.parse(block.text(block.manifest.docs)) as {
      operations: Record<string, OperationDocs>;
    }
  ).operations;
  const surface: SurfaceCatalog = {
    list: () =>
      catalog.list().map((op) => {
        const entry = catalog.describe(op);
        return {
          ...entry,
          admitted: true,
          docs: docs[op]!,
          inputSchema: block.resolvedSchema(entry.declaration.input) as Record<
            string,
            unknown
          >,
          outputSchema: block.resolvedSchema(
            entry.declaration.output,
          ) as Record<string, unknown>,
        };
      }),
    invoke: (request) => runtime.invoke(request),
  };
  return surface;
}
const context = {
  actor: { kind: "human" as const, id: "owner" },
  project: { id: "demo", root: "/demo" },
};

for (const [name, input, path, problem] of [
  ["empty", {}, "/title", "missing required"],
  ["wrong type", { title: 42 }, "/title", "wrong type"],
  [
    "unknown property",
    { title: "Task", titel: "typo" },
    "/titel",
    "unknown property",
  ],
  ["not allowed", { title: "" }, "/title", "not allowed"],
] as const) {
  test(`${name}: CLI and MCP preserve field diagnostics and a canonical working example`, async () => {
    const catalog = fixture();
    const cli = await runCli(
      catalog,
      ["issue", "create", "--input", JSON.stringify(input)],
      { caller: "agent", context },
    );
    const mcp = await createMcpHandlers(
      catalog,
      { expose: ["issue"] },
      { context },
    ).callTool("issue_create", input);
    expect(cli.exitCode).toBe(6);
    expect(mcp).toEqual(cli.envelope);
    if (cli.envelope.ok) throw new Error("expected refusal");
    expect(cli.envelope.error.code).toBe("INPUT_INVALID");
    const observed = cli.envelope.error.observed as {
      problems: readonly {
        pointer: string;
        problem: string;
        expected: string;
        received: string;
      }[];
    };
    const field = observed.problems.find((field) => field.pointer === path);
    expect(field?.problem).toBe(problem);
    expect(typeof field?.expected).toBe("string");
    expect(typeof field?.received).toBe("string");
    expect(cli.envelope.error.message).not.toContain(path);
    expect(cli.envelope.error.message).toContain(
      'Example: forge issue create --title "First task" --kind task',
    );
    const help = await runCli(catalog, ["issue", "create", "--help"]);
    expect(help.stdout).toContain(
      `Example: ${(cli.envelope.error.observed as { example: string }).example}`,
    );
    if (name === "empty")
      expect(cli.envelope.error.message).toContain("title is required");
    if (name === "wrong type")
      expect(cli.envelope.error.message).toBe(
        'Invalid input for issue.create:\ntitle must be text; received 42\nExample: forge issue create --title "First task" --kind task',
      );
    if (name === "unknown property")
      expect(cli.envelope.error.message).toContain(
        'Unknown field "titel"; did you mean "title"?',
      );
  });
}

test("positional misuse names the argument, expected form and canonical example", async () => {
  const reply = await runCli(fixture(), ["issue", "create", "Task"], {
    caller: "agent",
    context,
  });
  expect(reply.exitCode).toBe(6);
  if (reply.envelope.ok) throw new Error("expected refusal");
  expect(reply.envelope.error.message).toContain(
    'Unexpected argument "Task"; pass --title "Task"',
  );
  expect(reply.envelope.error.message).not.toContain("/arguments/0");
  expect(reply.stdout).toContain("Example: forge issue create --title");
});

test("all failing fields, nested references, array paths and escaped names retain diagnostics", () => {
  const registry = new SchemaRegistry([
    {
      $id: "https://test.invalid/input",
      type: "object",
      required: ["missing"],
      properties: {
        missing: { type: "string" },
        "a/b": { type: "array", items: { $ref: "#/$defs/entry" } },
      },
      additionalProperties: false,
      $defs: {
        entry: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "integer" } },
          additionalProperties: false,
        },
      },
    },
  ]);
  const problems = registry.validate(
    "https://test.invalid/input",
    { "a/b": [{ count: "many", cout: 2 }] },
    true,
  );
  const error = inputError("sample.run", problems);
  expect(problems.map((p) => p.pointer)).toEqual([
    "/missing",
    "/a~1b/0/count",
    "/a~1b/0/cout",
  ]);
  expect(error.message).toContain("missing is required");
  expect(error.message).toContain(
    'a/b[0].count must be integer; received "many"',
  );
  expect(error.message).toContain(
    'Unknown field "a/b[0].cout"; did you mean "count"?',
  );
  expect(error.message).not.toContain("/a~1b/0");
});

test("positional advice follows schemas and lists flags when no unique field fits", async () => {
  for (const [properties, required, expected] of [
    [{ caption: { type: "string" } }, ["caption"], 'pass --caption "Task"'],
    [{ count: { type: "integer" } }, ["count"], "use --count, --input JSON"],
    [
      { left: { type: "string" }, right: { type: "string" } },
      [],
      "use --left, --right, --input JSON",
    ],
    [
      { mode: { type: "string", enum: ["fast"] } },
      ["mode"],
      "use --mode, --input JSON",
    ],
    [
      { code: { type: "string", pattern: "^[0-9]+$" } },
      ["code"],
      "use --code, --input JSON",
    ],
  ] as const) {
    const entry = {
      ...candidate("sample.run", { args: [] }),
      inputSchema: { type: "object", properties, required },
    };
    const catalog = fakeCatalog([entry]);
    const reply = await runCli(catalog, ["sample", "run", "Task"]);
    if (reply.envelope.ok) throw new Error("expected refusal");
    expect(reply.envelope.error.message).toBe(
      `Invalid input for sample.run:\nUnexpected argument "Task"; ${expected}`,
    );
    expect(catalog.calls).toHaveLength(0);
  }
});

test("reserved text flag advice and examples use executable JSON input", async () => {
  const entry = {
    ...candidate("greet.shout", { args: [] }),
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    docs: {
      title: "Shout",
      summary: "Shout text",
      examples: [{ input: { text: "quiet" } }],
    },
  };
  const catalog = fakeCatalog([entry]);
  const bad = await runCli(catalog, ["greet", "shout", "--text", "quiet"]);
  expect(bad.exitCode).toBe(6);
  expect(bad.stdout).toContain("--text is reserved");
  expect(bad.stdout).not.toContain("pass --text");
  const help = await runCli(catalog, ["greet", "shout", "--help"]);
  expect(help.stdout).toContain("--input");
  expect(help.stdout).not.toContain("--text quiet");
  const good = await runCli(catalog, [
    "greet",
    "shout",
    "--input",
    '{"text":"quiet"}',
  ]);
  expect(good.exitCode).toBe(0);
  expect(catalog.calls.at(-1)?.input).toEqual({ text: "quiet" });
});
