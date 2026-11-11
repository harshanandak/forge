import { expect, setDefaultTimeout, test } from "bun:test";
import type { ForgeFailure } from "../../../src/contract/failure.ts";
import { Catalog } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { exitCode } from "../../../src/surface/result.ts";
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
  const ran: string[] = [];
  const runtime = new Runtime(catalog, trusted ? f.trust : new TrustStore(), {
    services() {
      opened.push("x");
      return Promise.resolve({ ownership: "borrowed", value: {} });
    },
    isolation: {
      open: () =>
        Promise.resolve({
          ok: true,
          handle: {
            ownership: "owned",
            close: () => Promise.resolve(),
            value: {
              run(options) {
                ran.push(options.operation);
                return options.encode("ok");
              },
            },
          },
        }),
    },
  });
  return { ...f, opened, ran, runtime };
}
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    return (e as ForgeFailure).error;
  }
};
const BAD_CONFIG = [
  {},
  { configSchema: "input.json" },
  { config: { x: 1 } },
] as const;
/** Rig arguments and request patch per check; the request rows replace the whole request. */
const rows: Record<string, [Parameters<typeof rig>, object]> = {
  request: [[], { requestId: 1 }],
  requestWithOp: [[], { op: "sample.run", requestId: 1 }],
  operation: [[], { op: "sample.missing" }],
  caller: [[{ callers: ["human"] }], {}],
  dryRun: [[], { dryRun: true }],
  context: [[{ context: "device" }], {}],
  input: [[], { input: 5 }],
  config: [[...BAD_CONFIG], {}],
  trust: [[{}, {}, {}, false], {}],
};
/** The code, exit and first message line `invoke` gave before this change. */
const before: Record<string, string> = {
  request: "INPUT_INVALID 6 invalid invocation request",
  requestWithOp: "INPUT_INVALID 6 invalid invocation request",
  operation: "UNKNOWN_COMMAND 3 unknown operation sample.missing",
  caller: "GRANT_REQUIRED 2 caller is not permitted",
  dryRun: "UNAVAILABLE 1 this profile has no dry-run execution contract",
  context:
    "CONTEXT_MISSING 6 this device operation needs actor, device, which the request did not supply",
  input: "INPUT_INVALID 6 Invalid input for sample.run:",
  config: "INPUT_INVALID 6 config does not match block schema",
  trust: "ADMISSION_REQUIRED 2 captured bytes need human admission",
};
for (const [name, [args, patch]] of Object.entries(rows))
  test(`preflight and invoke refuse the ${name} check as before`, async () => {
    const [code, exit, ...words] = before[name]!.split(" ");
    const r = rig(...args);
    const valid = !name.startsWith("request");
    const request = valid ? { ...r.request, ...patch } : patch;
    const seen: string[] = [];
    const thrown = refusal(() =>
      r.runtime.preflight(request, (q) => seen.push(q.op)),
    );
    const invoked = await r.runtime.invoke(request);
    for (const got of [thrown, invoked.ok ? undefined : invoked.error]) {
      expect(got?.code).toBe(code);
      expect(got?.message.split("\n")[0]).toBe(words.join(" "));
    }
    expect(exitCode(invoked)).toBe(Number(exit));
    expect("op" in invoked).toBe(valid);
    expect(seen).toEqual(valid ? [(request as { op: string }).op] : []);
    expect([r.opened, r.ran]).toEqual([[], []]);
  });

test("the earlier of two failing checks is the one reported by both entry points", async () => {
  for (const [args, patch, code] of [
    [[{ callers: ["human"] }], { input: 5 }, "GRANT_REQUIRED"],
    [[], { input: 5, dryRun: true }, "UNAVAILABLE"],
    [[...BAD_CONFIG, false], {}, "INPUT_INVALID"],
  ] as const) {
    const r = rig(...args);
    const request = { ...r.request, ...patch };
    const thrown = refusal(() => r.runtime.preflight(request));
    const invoked = await r.runtime.invoke(request);
    expect([thrown?.code, invoked.ok ? "" : invoked.error.code]).toEqual([
      code,
      code,
    ]);
  }
});

test("a renamed operation passes preflight with no services and runs under its declared name", async () => {
  const r = rig({ timeoutMs: 1000 }, {}, { rename: { sample: "renamed" } });
  const request = { ...r.request, op: "renamed.run" };
  const got = r.runtime.preflight(request);
  expect(got.block).toBe(r.block);
  expect(got.operation.declaredOp).toBe("sample.run");
  expect(got.context).toEqual({ variant: "stateless" });
  expect([r.opened, r.ran]).toEqual([[], []]);
  expect(await r.runtime.invoke(request)).toMatchObject({
    ok: true,
    result: "ok",
  });
  expect(r.ran).toEqual(["sample.run"]);
});
