import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import checkConfig from "../../../src/blocks/check/schemas/config.json" with { type: "json" };

type Call = (op: string, input?: object) => Promise<Record<string, unknown>>;

/** A fresh npm project with no .forge/config.yaml, as a new user has it. */
async function freshProject(run: (call: Call) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "forge-first-run-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fresh", private: true, scripts: { test: "x" } }),
  );
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  try {
    await run(async (op, input = {}) => {
      const result = await dispatch(
        assembly.catalog,
        op,
        input,
        localCall(assembly),
      );
      return { ...result, ...(record(result.ok ? result.result : {}) ?? {}) };
    });
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a fresh project imports the delivery template by name alone", async () => {
  await freshProject(async (call) => {
    expect(
      await call("template.import", { template: "delivery" }),
    ).toMatchObject({ ok: true, template: "harsha/delivery@0.1.2" });
  });
}, 30_000);

test("an input the schema refuses names the failing path and key", async () => {
  await freshProject(async (call) => {
    const failed = JSON.stringify(
      await call("template.import", { template: "delivery", force: true }),
    );
    expect(failed).toContain('Unknown field \\"force\\"');
    const nested = JSON.stringify(
      await call("config.set", { path: "/values/x", value: 1 }),
    );
    expect(nested).toContain("expectRevision is required");
  });
}, 30_000);

// The packed delivery journey proves npm is found end to end on each CI OS; this pins the names.
test("check's default environment names what finding the project's toolchain needs", () => {
  const environment = (
    checkConfig as { properties: { environment: { default: string[] } } }
  ).properties.environment.default;
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "ComSpec"])
    expect(environment).toContain(name);
}, 30_000);
