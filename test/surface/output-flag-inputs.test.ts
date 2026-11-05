import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

for (const name of ["text", "json"]) {
  for (const composition of ["allOf", "anyOf", "oneOf"]) {
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
