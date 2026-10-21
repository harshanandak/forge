import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";
import { validateDocsRecords } from "../../src/generated/validators.ts";

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
  expect(noun.stdout).toContain(
    `forge sample echo --input '{"value":"hello"}'`,
  );
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
  const reply = await runCli(catalog, ["verify", "--help"]);
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
