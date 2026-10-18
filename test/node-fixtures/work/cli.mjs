import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
const [installed, suppliedRoot] = process.argv.slice(2);
mkdirSync(suppliedRoot, { recursive: true });
const root = realpathSync(suppliedRoot);
const bin = join(installed, "dist/bin/forge.js");
const env = { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") };
assert.ok(
  spawnSync("bun", ["--version"], { env, windowsHide: true }).error,
  "installed CLI must run without Bun on PATH",
);
let seq = 0;
function cli(args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(
    result.status,
    expected,
    `${args.slice(0, 2).join(" ")}: ${result.stdout} ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}
const actor = { kind: "agent", id: "packed-agent" };
const context = {
  actor,
  session: { id: "packed-session" },
  project: { id: root, root },
};
function call(
  op,
  input = {},
  generation,
  expected = 0,
  requestId = `cli-${++seq}`,
) {
  return cli(
    [
      "catalog",
      "call",
      "--input",
      JSON.stringify({
        op: `issue.${op}`,
        input,
        requestId,
        context: {
          ...context,
          ...(generation === undefined ? {} : { leaseGeneration: generation }),
        },
      }),
    ],
    expected,
  );
}
const show = cli(["config", "show"]);
cli([
  "config",
  "apply",
  "--input",
  JSON.stringify({
    expectRevision: show.result.revision,
    patch: [
      { op: "set", path: "/mcp", value: { expose: ["issue"] } },
      {
        op: "set",
        path: "/blocks/work",
        value: { source: { builtin: "forge/work" }, bind: { state: "core" } },
      },
    ],
  }),
]);
assert.equal(
  call("create", { title: "Denied" }, undefined, 2).error.code,
  "ADMISSION_REQUIRED",
);
// A consumer project cannot point above itself. Use the installed source through a local symlink-free copy instead.
const { cpSync } = await import("node:fs");
cpSync(join(installed, "dist/src/blocks/work"), join(root, "work-bytes"), {
  recursive: true,
});
const checked = cli(["block", "check", "./work-bytes"]);
const digest = checked.result.digest;
cli(["block", "admit", digest]);
cli([
  "config",
  "grant",
  "--input",
  JSON.stringify({ digest, effects: ["issue:write"] }),
]);
const created = call("create", {
  title: "Packed issue",
  body: "kept exactly",
  kind: "task",
  labels: ["acceptance"],
}).result;
assert.equal(created.title, "Packed issue");
assert.deepEqual(created.labels, ["acceptance"]);
assert.deepEqual(call("show", { id: created.id }).result, created);
assert.deepEqual(
  call("ready").result.items.map((x) => x.id),
  [created.id],
);
const grant = call(
  "claim",
  { id: created.id, ttlSeconds: 60 },
  undefined,
  0,
  "claim-original",
).result;
assert.equal(grant.generation, 1);
assert.deepEqual(
  call(
    "claim",
    { id: created.id, ttlSeconds: 60 },
    undefined,
    0,
    "claim-original",
  ).result,
  grant,
);
assert.equal(call("ready").result.items.length, 0);
const comment = call("comment", {
  id: created.id,
  body: "Written through the installed CLI",
}).result;
const read = call("comments", { id: created.id }).result.records[0];
assert.equal(read.key, comment.commentId);
assert.equal(read.value.body, "Written through the installed CLI");
assert.deepEqual(read.updatedBy, actor);
const closed = call(
  "close",
  { id: created.id, reason: "acceptance passed" },
  grant.generation,
).result;
assert.equal(closed.status, "closed");
assert.deepEqual(call("show", { id: created.id }).result, closed);
assert.equal(
  call("create", { title: "Bad kind", kind: "unknown" }, undefined, 6).error
    .code,
  "INPUT_INVALID",
);
console.log(
  "PASS installed CLI: create, ready, claim/replay, live ready, comment/readback, close/readback, unknown kind",
);

const { pathToFileURL } = await import("node:url");
const { createAssembly } = await import(
  pathToFileURL(join(installed, "dist/src/assembly/index.js")).href
);
const { createMcpHandlers } = await import(
  pathToFileURL(join(installed, "dist/src/surface/mcp.js")).href
);
const assembly = await createAssembly({
  root,
  deviceRoot: env.FORGE_DEVICE_ROOT,
});
try {
  const handlers = createMcpHandlers(assembly.catalog, assembly.exposure);
  const mcp = await handlers.callTool("catalog_call", {
    op: "issue.show",
    input: { id: created.id },
    context,
    requestId: "mcp-show",
  });
  assert.equal(mcp.ok, true, JSON.stringify(mcp));
  assert.deepEqual(
    mcp.result,
    closed,
    "MCP and CLI must read the same accepted state",
  );
  const bad = await handlers.callTool("catalog_call", {
    op: "issue.create",
    input: { title: "bad", kind: "unknown" },
    context,
    requestId: "mcp-bad",
  });
  assert.equal(bad.error.code, "INPUT_INVALID");
  console.log("PASS generated MCP: canonical readback and error parity");
} finally {
  await assembly.close();
}
