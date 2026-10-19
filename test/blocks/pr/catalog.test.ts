import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { CapturedBlock, Catalog } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { validateBlockManifest } from "../../../src/generated/validators.ts";
import { Recorder } from "../../../tools/conformance/record.ts";
import { assertConformance } from "../../../tools/conformance/assert.ts";
import { ready, policy } from "../../node-fixtures/pr/evidence.ts";
import { verdict } from "../../../src/blocks/pr/verdict.ts";
const root = new URL("../../../src/blocks/pr/", import.meta.url);
function fixture() {
  const files = new Map<string, string>();
  for (const name of [
    "forge.block.json",
    "docs.json",
    ...readdirSync(new URL("schemas/", root)).map((x) => `schemas/${x}`),
  ])
    files.set(name, readFileSync(new URL(name, root), "utf8"));
  files.set(
    "entry.cjs",
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(new URL("entry.cts", root), "utf8"),
    ),
  );
  const parsed = validateBlockManifest(
    JSON.parse(files.get("forge.block.json")!) as unknown,
  );
  if (!parsed.ok) throw Error("Invalid manifest");
  const block = new CapturedBlock(files, parsed.value);
  const catalog = new Catalog(
    {
      schemaVersion: "forge.config/1",
      blocks: { pr: { source: { path: "./pr" }, config: policy } },
    },
    new Map([["pr", block]]),
    undefined,
    ["forge.crypto@1.0.0"],
  );
  const trust = new TrustStore();
  trust.admit("human", block.digest);
  const runtime = new Runtime(catalog, trust, {
    isolation: nodeRunIsolation,
    services: () =>
      Promise.resolve({
        ownership: "borrowed",
        value: {
          crypto: {
            sha256: (text: string) =>
              createHash("sha256").update(text).digest("hex"),
          },
        },
      }),
  });
  const recorder = new Recorder((request) => runtime.invoke(request));
  const call = (input: unknown) =>
    recorder.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "pr-evaluate",
      op: "pr.evaluate",
      input,
      caller: "human",
      context: {},
    });
  return { block, recorder, call };
}
test("pr.evaluate executes captured code with shared evidence and verdict contracts", async () => {
  const f = fixture();
  expect(() => assertConformance([f.block], [])).toThrow(/unobserved/);
  const evidence: unknown = JSON.parse(
    JSON.stringify(ready()).replaceAll(
      "2026-10-20T00:00:00Z",
      "2000-01-01T00:00:00Z",
    ),
  );
  const result = await f.call(evidence);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(JSON.stringify(result.error));
  expect(result.result).toEqual(verdict(evidence, policy, Date.now()));
  const refusal = await f.call({ ...ready(), checks: "malformed" });
  expect(refusal.ok).toBe(false);
  if (refusal.ok) throw Error("Invalid evidence accepted");
  expect(refusal.error.code).toBe("INPUT_INVALID");
  // The generic guard deliberately rejects invalid *inputs*; test admission separately.
  assertConformance([f.block], f.recorder.observations().slice(0, 1));
  expect(() => assertConformance([f.block], f.recorder.observations())).toThrow(
    /input/,
  );
}, 5000);
