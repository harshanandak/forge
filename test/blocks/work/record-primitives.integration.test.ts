import { test, setDefaultTimeout } from "bun:test";
import { ok, rejects } from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { refuse } from "../../../src/core/trust/index.ts";

setDefaultTimeout(30_000);
const root = resolve(import.meta.dirname, "../../..");
const helper = resolve(root, "tools/bundle-work-primitives.ts");
const loaded = (existsSync(helper) ? require(helper) : {}) as Record<
  string,
  unknown
>;
async function run(source: string) {
  const opened = await nodeRunIsolation.open();
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  try {
    return await opened.handle.value.run({
      source,
      filename: "captured-work.cjs",
      operation: "lane.record",
      args: { input: {}, services: {} },
      encode: JSON.stringify,
      fail: refuse,
      timeoutMs: 5000,
      deadline: Date.now() + 5000,
      signal: new AbortController().signal,
      settled: () => undefined,
    });
  } finally {
    await opened.handle.close();
  }
}
const messages = (error: unknown): string[] =>
  error !== null && typeof error === "object"
    ? [
        String(Reflect.get(error, "message")),
        ...messages(Reflect.get(error, "cause")),
      ]
    : [];
const inputInvalid = (error: unknown) =>
  error instanceof ForgeFailure && error.error.code === "INPUT_INVALID";

test("captured work execution needs inlined primitives and no VM loader", async () => {
  const inline = loaded.inlineWorkPrimitives;
  ok(typeof inline === "function", "Missing work primitive bundler");
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(resolve(root, "src/blocks/work/entry.cts"), "utf8"),
  );
  await rejects(run(source), (error) =>
    messages(error).some((text) => text.includes("require is not defined")),
  );
  const bundled = await (
    inline as (entry: string, path: string) => Promise<string>
  )(source, resolve(root, "src/blocks/work/record-primitives.ts"));
  await rejects(run(bundled), inputInvalid);
});

test("the built captured work entry executes without its dependency file", async () => {
  const source = readFileSync(
    resolve(root, "dist/src/blocks/work/entry.cjs"),
    "utf8",
  );
  await rejects(run(source), inputInvalid);
});
