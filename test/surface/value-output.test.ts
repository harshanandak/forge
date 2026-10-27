import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { failure } from "../../src/surface/result.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

test("a declared value output prints JSON, suppresses null, and preserves failures", async () => {
  const entry = { ...candidate(), outputSchema: { "x-cli-output": "value" } };
  for (const result of [{ changed: true }, null]) {
    const answer = {
      ok: true as const,
      op: entry.op,
      status: "OK" as const,
      result,
      warnings: [],
    };
    const response = await runCli(fakeCatalog([entry], answer), [
      "sample",
      "echo",
      "hello",
    ]);
    expect(response.stdout).toBe(
      result === null ? "" : `${JSON.stringify(result)}\n`,
    );
    expect(response.exitCode).toBe(0);
    expect(response.envelope).toEqual(answer);
  }
  const response = await runCli(
    fakeCatalog([entry], failure("UNAVAILABLE", "read failed")),
    ["sample", "echo", "hello"],
  );
  expect(response.exitCode).toBe(1);
  const body: unknown = JSON.parse(response.stdout);
  expect(body).toMatchObject({ error: { message: "read failed" } });
}, 30_000);
