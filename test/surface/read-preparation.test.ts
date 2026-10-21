import { expect, test } from "bun:test";
import { runCli } from "../../src/surface/cli.ts";
import { discoveryOperations } from "../../src/surface/discovery.ts";
import type { SurfaceCatalog } from "../../src/surface/catalog.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

test("a CLI read prepares discovery once for parsing and dispatch", async () => {
  let preparations = 0;
  const catalog: SurfaceCatalog = {
    list() {
      preparations++;
      return discoveryOperations;
    },
    invoke() {
      return Promise.reject(
        new Error("Discovery must not activate a provider"),
      );
    },
  };
  const response = await runCli(catalog, [
    "catalog",
    "describe",
    "catalog.list",
  ]);
  expect(response.exitCode).toBe(0);
  expect(preparations).toBe(1);
}, 1000);

test("the next CLI read discovers changed declarations again", async () => {
  let name = "sample.first";
  let preparations = 0;
  const source = fakeCatalog();
  const catalog: SurfaceCatalog = {
    ...source,
    list() {
      preparations++;
      return [candidate(name)];
    },
  };
  for (const op of ["sample.first", "sample.second"]) {
    name = op;
    const response = await runCli(catalog, [op, "hello"]);
    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout)).toMatchObject({
      op,
      result: { value: "hello" },
    });
  }
  expect(preparations).toBe(2);
  expect(source.calls.map((call) => call.op)).toEqual([
    "sample.first",
    "sample.second",
  ]);
}, 1000);
