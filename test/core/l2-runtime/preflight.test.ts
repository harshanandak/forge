import { expect, setDefaultTimeout, test } from "bun:test";
import type { ForgeFailure } from "../../../src/contract/failure.ts";
import { Catalog } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { TrustStore } from "../../fixtures/owner-approval.ts";
import { fixture } from "../async-handlers/fixture.ts";
setDefaultTimeout(10_000);
function rig(declaration = {}, extra = {}, block = {}, trusted = true) {
  const f = fixture("() => 'ok'", declaration, false, extra);
  const config = { source: { path: "./sample" }, ...block };
  const catalog = new Catalog(
    { schemaVersion: "forge.config/1", blocks: { sample: config } },
    new Map([["sample", f.block]]),
  );
  const opened: string[] = [];
  const services = () => Promise.reject(new Error(String(opened.push("x"))));
  const trust = trusted ? f.trust : new TrustStore();
  return { ...f, opened, runtime: new Runtime(catalog, trust, { services }) };
}
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    return (e as ForgeFailure).error;
  }
};
const cases: [string, Parameters<typeof rig>, object][] = [
  ["request", [], { requestId: 1 }],
  ["operation", [], { op: "sample.missing" }],
  ["caller", [{ callers: ["human"] }], {}],
  ["dry run", [], { dryRun: true }],
  ["context", [{ context: "device" }], {}],
  ["input", [], { input: 5 }],
  ["config", [{}, { configSchema: "input.json" }, { config: { x: 1 } }], {}],
  ["trust", [{}, {}, {}, false], {}],
];
for (const [name, args, patch] of cases)
  test(`preflight and invoke refuse the ${name} check alike`, async () => {
    const r = rig(...args);
    const request = name === "request" ? patch : { ...r.request, ...patch };
    const op = (request as { op?: string }).op;
    const seen: string[] = [];
    const thrown = refusal(() =>
      r.runtime.preflight(request, (q) => seen.push(q.op)),
    );
    const invoked = await r.runtime.invoke(request);
    const error = invoked.ok ? undefined : invoked.error;
    expect(thrown).toMatchObject({
      code: error?.code,
      message: error?.message,
    });
    expect(invoked.op).toBe(op);
    expect(seen).toEqual(op === undefined ? [] : [op]);
    expect(r.opened).toEqual([]);
  });

test("the earlier of two failing checks is the one reported", () => {
  const a = rig({ callers: ["human"] });
  const b = rig();
  const late = refusal(() => a.runtime.preflight({ ...a.request, input: 5 }));
  const dry = refusal(() =>
    b.runtime.preflight({ ...b.request, input: 5, dryRun: true }),
  );
  expect([late?.code, dry?.code]).toEqual(["GRANT_REQUIRED", "UNAVAILABLE"]);
});
test("preflight returns the block, declared operation and bound context, and opens nothing", () => {
  const r = rig({}, {}, { rename: { sample: "renamed" } });
  const request = { ...r.request, op: "renamed.run" };
  const got = r.runtime.preflight(request);
  expect(got.block).toBe(r.block);
  expect(got.operation.declaredOp).toBe("sample.run");
  expect(got.context).toEqual({ variant: "stateless" });
  expect(r.opened).toEqual([]);
});
