import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";
import { validateDocsRecords } from "../../src/generated/validators.ts";
import { renderExample } from "../../src/contract/example.ts";

test("PowerShell JSON fallback keeps a phrase inside one native argument", () => {
  const example = renderExample(
    "sample.echo",
    {
      title: "Echo",
      summary: "Echo.",
      examples: [{ input: { value: "First task", labels: ["release"] } }],
    },
    { oneOf: [candidate().inputSchema] },
  );
  expect(example.split("\n    PowerShell 5.1: ")[1]).toBe(
    String.raw`forge sample echo --input '{\"value\":\"First\u0020task\",\"labels\":[\"release\"]}'`,
  );
  expect(example.split("\n")[0]).toBe(
    `POSIX: forge sample echo --input '{"value":"First task","labels":["release"]}'`,
  );
}, 30000);

test("documentation examples require an input or runnable command", () => {
  const doc = (example: object) => ({
    operations: {
      "sample.echo": {
        title: "Echo",
        summary: "Echo a value.",
        examples: [example],
      },
    },
  });
  expect(validateDocsRecords(doc({})).ok).toBe(false);
  expect(validateDocsRecords(doc({ input: { value: "hello" } })).ok).toBe(true);
  expect(
    validateDocsRecords(doc({ command: "forge sample echo hello" })).ok,
  ).toBe(true);
}, 30000);

test("help is concise text by default and the full contract needs --json", async () => {
  const entry = {
    ...candidate(),
    docs: {
      title: "Echo",
      summary: "Echo a value.",
      examples: [{ input: { value: "hello" } }],
    },
  };
  const catalog = fakeCatalog([entry]);
  for (const args of [[], ["--help"], ["--help", "--text"]]) {
    const reply = await runCli(catalog, args);
    expect(reply.stdout).toStartWith("Usage: forge");
    expect(reply.stdout).toContain("sample");
    expect(reply.stdout).toContain("--help --json");
    expect(reply.stdout).not.toContain("inputSchema");
    expect(reply.stdout.length).toBeLessThan(2000);
  }
  const noun = await runCli(catalog, ["sample", "--help"]);
  expect(noun.stdout).toContain("echo <value>");
  expect(noun.stdout).toContain("Echo a value.");
  expect(noun.stdout).not.toContain("Example:");
  const verb = await runCli(catalog, ["sample", "echo", "--help"]);
  expect(verb.stdout).toContain("forge sample echo hello");
  expect(noun.stdout).not.toContain("catalog describe <op>");
  expect(
    JSON.parse((await runCli(catalog, ["sample", "--help", "--json"])).stdout),
  ).toMatchObject({ ok: true, result: { operations: [entry] } });
  expect(catalog.calls).toHaveLength(0);
  expect(
    (
      await runCli(catalog, [
        "sample",
        "echo",
        "--input",
        JSON.stringify(entry.docs.examples[0]?.input),
      ])
    ).exitCode,
  ).toBe(0);
}, 30000);

test("help uses resolved arguments while JSON keeps references, and command examples follow the noun", async () => {
  const entry = candidate("verify.show");
  const catalog = fakeCatalog([
    {
      ...entry,
      inputSchema: { $ref: "https://example.com/input.json" },
      argumentSchema: entry.inputSchema,
      docs: {
        title: "Read a value",
        summary: "Read a value.",
        examples: [
          { command: "forge check show --value hello; forge check list" },
        ],
      },
    },
  ]);
  const reply = await runCli(catalog, ["verify", "show", "--help"]);
  expect(reply.stdout).toContain("verify show <value>");
  expect(reply.stdout).toContain(
    "forge verify show --value hello; forge verify list",
  );
  expect(
    (await runCli(catalog, ["verify", "show", "--value", "hello"])).envelope,
  ).toMatchObject({ ok: true, result: { value: "hello" } });
  expect(
    (await runCli(catalog, ["verify", "--help", "--json"])).stdout,
  ).toContain("https://example.com/input.json");
}, 30000);

test("verb help derives every flag, type, meaning and requirement from resolved schemas", async () => {
  const entry = candidate();
  const catalog = fakeCatalog([
    {
      ...entry,
      argumentSchema: {
        ...entry.inputSchema,
        properties: {
          value: {
            type: "string",
            description: "The text to echo.\nKept as supplied.",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Match all labels.",
          },
          limit: { type: "integer", description: "Maximum results." },
          preRelease: { type: "boolean", description: "Include previews." },
        },
      },
    },
  ]);
  const reply = await runCli(catalog, ["sample", "echo", "--help"]);
  for (const line of [
    "--value <string> (required)  The text to echo. Kept as supplied.",
    "--labels <string[]> (optional)  Match all labels.",
    "--limit <integer> (optional)  Maximum results.",
    "--pre-release <boolean> (optional)  Include previews.",
  ])
    expect(reply.stdout).toContain(line);
}, 30000);

test("complex examples name POSIX and PowerShell quoting separately", async () => {
  const entry = {
    ...candidate(),
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
    },
    docs: {
      title: "Echo",
      summary: "Echo.",
      examples: [{ input: { value: "hello", labels: ["release"] } }],
    },
  };
  const reply = await runCli(fakeCatalog([entry]), [
    "sample",
    "echo",
    "--help",
  ]);
  expect(reply.stdout).toContain("POSIX:");
  expect(reply.stdout).toContain("PowerShell 5.1:");
  expect(reply.stdout).toContain("--labels");
}, 30000);

test("examples use portable double quotes for scalar phrases and JSON for undeclared flags", async () => {
  const base = candidate();
  const entry = {
    ...base,
    docs: {
      title: "Echo",
      summary: "Echo.",
      examples: [{ input: { value: "First task" } }],
    },
  };
  expect(
    (await runCli(fakeCatalog([entry]), ["sample", "echo", "--help"])).stdout,
  ).toContain('forge sample echo "First task"');
  const union = {
    ...entry,
    inputSchema: { oneOf: [base.inputSchema] },
    docs: {
      ...entry.docs,
      examples: [{ input: { value: "First task", count: 2 } }],
    },
  };
  const result = await runCli(fakeCatalog([union]), [
    "sample",
    "echo",
    "--help",
  ]);
  expect(result.stdout).toContain("--input '");
  expect(result.stdout).not.toContain("--count 2");
}, 30000);
