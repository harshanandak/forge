import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createConfigOperations,
  nodeConfigFiles,
  yamlConfigCodec,
} from "forge-workflow/config";
import { createNodeBlockCatalog } from "forge-workflow/runtime";
import { StateOwner } from "forge-workflow/state";
import { sqliteStore } from "forge-workflow/adapters/sqlite";
assert.equal(process.versions.bun, undefined);
// Resolve asset URLs from the public package root; no developer checkout participates.
const asset = (path) =>
  JSON.parse(
    readFileSync(
      new URL(path, import.meta.resolve("forge-workflow/package.json")),
      "utf8",
    ),
  );
const fragment = asset("./dist/src/core/config/operations.json");
assert.ok(fragment.operations["config.show"]);
assert.equal(asset("./dist/schemas/config.json").type, "object");
assert.ok(asset("./dist/src/core/config/schemas/show.output.json"));
const operations = createConfigOperations({
  files: nodeConfigFiles(process.cwd()),
  codec: yamlConfigCodec,
  clock: { now: () => Date.now() },
  detect: () => [],
  templates: { list: () => [], get: () => undefined },
  builtinSource: () => undefined,
});
assert.equal(operations["config.show"]({}).configured, false);
const block = join(process.cwd(), "sample");
mkdirSync(block);
writeFileSync(
  join(block, "block.json"),
  JSON.stringify({
    schemaVersion: "forge.block/1",
    id: "example.org/sample",
    version: "1.0.0",
    authorAbi: "forge.author/v1",
    profile: "trusted-action-sync/v1",
    entry: "index.cjs",
    docs: "docs.json",
    operations: {
      "sample.run": {
        input: "input.json",
        output: "output.json",
        context: "stateless",
        effects: [],
        idempotent: true,
        callers: ["human", "agent"],
        stability: "stable",
      },
    },
  }),
);
for (const name of ["input", "output"])
  writeFileSync(join(block, `${name}.json`), '{"type":"object"}');
writeFileSync(
  join(block, "docs.json"),
  JSON.stringify({
    schemaVersion: "forge.docs/1",
    operations: { "sample.run": { title: "Run", summary: "Run sample." } },
  }),
);
writeFileSync(
  join(block, "index.cjs"),
  'module.exports = { "sample.run": () => ({}) };',
);
const catalog = createNodeBlockCatalog(process.cwd());
const checked = await catalog.invoke({
  schemaVersion: "forge.invocation/1",
  requestId: "smoke",
  op: "block.check",
  input: { path: "./sample" },
  caller: "agent",
  context: {},
});
assert.equal(checked.ok, true, JSON.stringify(checked));
const opened = await sqliteStore.open({ path: ":memory:", readOnly: false });
assert.equal(opened.ok, true);
try {
  new StateOwner(opened.handle.value, { now: () => Date.now() });
} finally {
  await opened.handle.close();
}
await assert.rejects(import("forge-workflow/dist/src/core/state/index.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
console.log(
  "public API smoke: config.show, block.check, state and private-path refusal PASS",
);
