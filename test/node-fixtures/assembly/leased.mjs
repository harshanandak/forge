import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [source, root] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(join(source, "dist/src", file)).href);
const { createAssembly } = await load("assembly/index.js");
const { dispatch } = await load("surface/dispatch.js");
const { firstPartyBlocks } = await load("assembly/first-party.js");
const block = join(root, "counter");
mkdirSync(block, { recursive: true });
const write = (name, value) =>
  writeFileSync(
    join(block, name),
    typeof value === "string" ? value : JSON.stringify(value),
  );
const operations = {};
for (const verb of [
  "show",
  "claim",
  "renew",
  "release",
  "put",
  "sneak",
  "cancel",
  "undo",
]) {
  const leased = [
    "claim",
    "renew",
    "release",
    "put",
    "cancel",
    "undo",
  ].includes(verb);
  operations[`counter.${verb}`] = {
    input: "input.json",
    output: "output.json",
    context: leased ? "leased" : "project",
    timeoutMs: 15000,
    ...(leased
      ? {
          leaseMode: ["claim", "cancel", "undo"].includes(verb)
            ? "acquire"
            : "held",
        }
      : {}),
    effects: verb === "show" || verb === "sneak" ? [] : ["counter:write"],
    callers: ["agent", "human"],
    idempotent: false,
    stability: "experimental",
  };
}
write("forge.block.json", {
  schemaVersion: "forge.block/1",
  id: "test/counter",
  version: "1.0.0",
  authorAbi: "forge.author/v1",
  profile: "trusted-action-sync/v1",
  entry: "entry.cjs",
  docs: "docs.json",
  requires: [{ slot: "state", interface: "forge.state@1" }],
  operations,
});
write("docs.json", {
  operations: Object.fromEntries(
    Object.keys(operations).map((key) => [key, { title: key, summary: key }]),
  ),
});
write("input.json", { type: "object" });
write("output.json", {});
write(
  "entry.cjs",
  `module.exports = {
 "counter.cancel": ({services:s}) => { const grant = s.state.acquire("cancelled", 60000); grant.generation = 999; return s.state.release("cancelled"); },
 "counter.undo": ({services:s}) => s.state.release("count"),
 "counter.show": ({services:s}) => s.state.get("count") ?? null,
 "counter.claim": ({services:s}) => s.state.acquire("count", 60000),
 "counter.renew": ({services:s}) => s.state.renew("count", 120000),
 "counter.release": ({services:s}) => s.state.release("count"),
 "counter.put": ({services:s}) => s.state.put("count", {count: 1}, {expectRevision: 0}),
 "counter.sneak": ({services:s}) => s.state.acquire("count", 60000)
};`,
);
firstPartyBlocks["test/counter"] = pathToFileURL(block);
const assembly = await createAssembly({
  root,
  deviceRoot: join(root, "device"),
});
const context = {
  actor: { kind: "agent", id: "a" },
  device: { id: join(root, "device") },
  session: { id: "a" },
  project: { id: root, root },
};
let seq = 0;
const invoke = (
  op,
  input = {},
  ctx = context,
  caller = "agent",
  requestId = `request-${++seq}`,
) =>
  assembly.catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId,
    op,
    input,
    context:
      caller === "human"
        ? { ...ctx, actor: { kind: "human", id: "owner" } }
        : ctx,
    caller,
  });
try {
  const show = await invoke("config.show");
  assert.equal(show.ok, true);
  const apply = await invoke("config.apply", {
    expectRevision: show.result.revision,
    patch: [
      {
        op: "set",
        path: "/blocks/counter",
        value: { source: { builtin: "test/counter" }, bind: { state: "core" } },
      },
    ],
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.deepEqual(assembly.catalog.unavailable(), []);
  // A registered built-in is shipped with the package: no admit or grant step.
  assert.equal((await invoke("counter.show")).result, null);
  assert.equal(
    existsSync(join(root, ".forge/state.sqlite")),
    false,
    "read must not create state",
  );
  const grant = await dispatch(
    assembly.catalog,
    "catalog.call",
    { op: "counter.claim", input: {}, context, requestId: "first" },
    { caller: "agent" },
  );
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.equal(grant.result.generation, 1);
  assert.deepEqual(
    (await invoke("counter.claim", {}, context, "agent", "first")).result,
    grant.result,
  );
  const other = { ...context, session: { id: "b" } };
  assert.equal(
    (await invoke("counter.claim", {}, other)).error.code,
    "LEASE_HELD",
  );
  assert.equal((await invoke("counter.renew")).error.code, "CONTEXT_MISSING");
  const held = { ...context, leaseGeneration: 1 };
  assert.equal((await invoke("counter.put", {}, held)).ok, true);
  assert.deepEqual((await invoke("counter.show")).result.value, { count: 1 });
  assert.equal(
    (await invoke("counter.renew", {}, { ...held, session: { id: "b" } })).error
      .code,
    "LEASE_NOT_HELD",
  );
  assert.equal((await invoke("counter.renew", {}, held)).result.generation, 1);
  assert.equal((await invoke("counter.release", {}, held)).ok, true);
  assert.equal((await invoke("counter.claim", {}, other)).result.generation, 2);
  assert.equal(
    (await invoke("counter.put", {}, held)).error.code,
    "LEASE_STALE",
  );
  assert.equal((await invoke("counter.sneak")).error.code, "GRANT_REQUIRED");
  assert.equal(
    (await invoke("counter.claim", {}, { ...other, project: { id: "other" } }))
      .error.code,
    "INPUT_CONFLICT",
  );
  const cancelled = await invoke("counter.cancel");
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.ok(
    cancelled.result.releasedAt,
    "acquiring invocation may revoke its own grant",
  );
  assert.equal(
    (await invoke("counter.undo")).error.code,
    "CONTEXT_MISSING",
    "acquiring invocation cannot revoke an ambient grant",
  );
  console.log("PASS generic leased assembly");
} finally {
  await assembly.close();
  delete firstPartyBlocks["test/counter"];
}
