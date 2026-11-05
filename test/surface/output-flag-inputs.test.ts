import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

for (const name of ["text", "json"]) {
  test(`CLI preserves --${name} formatting when only non-object branches declare the input`, async () => {
    for (const type of ["string", ["string", "null"]]) {
      for (const branch of [
        { type, properties: { [name]: { type: "boolean" } } },
        { type, allOf: [{ properties: { [name]: { type: "boolean" } } }] },
      ]) {
        const entry = {
          ...candidate("sample.capture", { args: [] }),
          inputSchema: {
            oneOf: [{ type: "object", additionalProperties: false }, branch],
          },
        };
        const catalog = fakeCatalog([entry]);
        const response = await runCli(catalog, [entry.op, `--${name}`]);
        expect(response.exitCode).toBe(0);
        expect(response.envelope).toMatchObject({ ok: true, result: {} });
        expect(catalog.calls).toHaveLength(1);
        expect(catalog.calls[0]?.input).toEqual({});
        if (name === "text") expect(response.stdout).toContain("ok: true\n");
        else expect(JSON.parse(response.stdout)).toMatchObject({ ok: true });
      }
    }
  }, 30_000);

  test(`CLI refuses --${name} when the branch type includes object`, async () => {
    const entry = {
      ...candidate("sample.capture", { args: [] }),
      inputSchema: {
        oneOf: [
          { type: "object", additionalProperties: false },
          {
            type: ["string", "object"],
            properties: { [name]: { type: "boolean" } },
          },
        ],
      },
    };
    const catalog = fakeCatalog([entry]);
    const response = await runCli(catalog, [entry.op, `--${name}`]);
    expect(response.exitCode).toBe(6);
    expect(response.envelope).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
    expect(catalog.calls).toHaveLength(0);
  }, 30_000);

  for (const composition of ["allOf", "anyOf", "oneOf"]) {
    test(`CLI refuses --${name} declared through a local ref in ${composition}`, async () => {
      const entry = {
        ...candidate("sample.capture", { args: [] }),
        inputSchema: {
          type: "object",
          [composition]: [{ $ref: "#/$defs/flags" }],
          $defs: { flags: { properties: { [name]: { type: "boolean" } } } },
        },
      };
      const catalog = fakeCatalog([entry]);
      const response = await runCli(catalog, [entry.op, `--${name}`]);
      expect(response.exitCode).toBe(6);
      expect(response.envelope).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      expect(catalog.calls).toHaveLength(0);
    }, 30_000);

    test(`CLI refuses an ambiguous --${name} input declared through ${composition}`, async () => {
      const entry = {
        ...candidate("sample.capture", { args: [] }),
        inputSchema: {
          type: "object",
          [composition]: [
            { allOf: [{ properties: { [name]: { type: "boolean" } } }] },
          ],
        },
      };
      const catalog = fakeCatalog([entry]);
      const response = await runCli(catalog, [entry.op, `--${name}`]);
      expect(response.exitCode).toBe(6);
      expect(response.envelope).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      expect(response.stdout).toContain(`--${name}`);
      expect(response.stdout).toContain("reserved");
      expect(response.stdout).toContain("--input JSON");
      expect(catalog.calls).toHaveLength(0);

      const input = { [name]: true };
      const explicit = await runCli(catalog, [
        entry.op,
        "--input",
        JSON.stringify(input),
        `--${name}`,
      ]);
      expect(explicit.exitCode).toBe(0);
      expect(catalog.calls.at(-1)?.input).toEqual(input);
    }, 30_000);
  }

  test(`CLI refuses an ambiguous --${name} input with a JSON remedy`, async () => {
    for (const type of ["boolean", "string"]) {
      const entry = {
        ...candidate("sample.capture", { args: [] }),
        inputSchema: {
          type: "object",
          properties: { [name]: { type } },
          additionalProperties: false,
        },
      };
      const catalog = fakeCatalog([entry]);
      const values = type === "boolean" ? [] : ["hello"];
      for (const argv of [
        [entry.op, `--${name}`, ...values],
        [`--${name}`, "sample", "capture", ...values],
      ]) {
        const response = await runCli(catalog, argv);
        expect(response.exitCode).toBe(6);
        expect(response.envelope).toMatchObject({
          ok: false,
          error: { code: "INPUT_INVALID" },
        });
        expect(response.stdout).toContain(`--${name}`);
        expect(response.stdout).toContain("reserved");
        expect(response.stdout).toContain("--input JSON");
        expect(catalog.calls).toHaveLength(0);
      }
    }
  }, 30_000);

  test(`CLI delivers the ${name} input through JSON while preserving output flags`, async () => {
    const entry = {
      ...candidate("sample.capture", { args: [] }),
      inputSchema: {
        type: "object",
        properties: { [name]: { type: "string" } },
        required: [name],
        additionalProperties: false,
      },
    };
    const catalog = fakeCatalog([entry]);
    const input = { [name]: "hello" };
    for (const flag of ["--text", "--json"]) {
      const response = await runCli(catalog, [
        entry.op,
        "--input",
        JSON.stringify(input),
        flag,
      ]);
      expect(response.exitCode).toBe(0);
      expect(response.envelope).toMatchObject({ ok: true, result: input });
      expect(catalog.calls.at(-1)?.input).toEqual(input);
      if (flag === "--text") {
        expect(response.stdout).toContain(`${name}: hello`);
      } else {
        expect(JSON.parse(response.stdout)).toMatchObject({
          ok: true,
          result: input,
        });
      }
    }
  }, 30_000);
}

test("CLI preserves --text formatting with a cyclic composition ref", async () => {
  const entry = {
    ...candidate("sample.capture", { args: [] }),
    inputSchema: {
      type: "object",
      allOf: [{ $ref: "#/$defs/a" }],
      $defs: { a: { allOf: [{ $ref: "#/$defs/a" }] } },
    },
  };
  const catalog = fakeCatalog([entry]);
  const response = await runCli(catalog, [entry.op, "--text"]);
  expect(response.exitCode).toBe(0);
  expect(response.envelope).toMatchObject({ ok: true, result: {} });
  expect(catalog.calls).toHaveLength(1);
  expect(catalog.calls[0]?.input).toEqual({});
  expect(response.stdout).toContain("ok: true\n");
}, 30_000);
