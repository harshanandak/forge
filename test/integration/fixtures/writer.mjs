import assert from "node:assert/strict";
import { join } from "node:path";
import { createAssembly, localContext } from "forge-workflow/runtime";
import { StateOwner } from "forge-workflow/state";
import { sqliteStore } from "forge-workflow/adapters/sqlite";
const [root, deviceRoot] = process.argv.slice(2);
assert.equal(process.versions.bun, undefined);
const actor = { kind: "agent", id: "writer" };
const assembly = await createAssembly({ root, deviceRoot });
const opened = await sqliteStore.open({
  path: join(root, ".forge/state.sqlite"),
  readOnly: true,
});
assert.ok(opened.ok);
const revision = new StateOwner(opened.handle.value, {
  now: () => Date.now(),
}).get("io.github.alice/semver", "released").revision;
await opened.handle.close();
process.send({ ready: true, revision });
process.once("message", async () => {
  try {
    const result = await assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: `writer-${process.pid}`,
      op: "semver.mark",
      caller: "agent",
      context: localContext(assembly, actor),
      input: { version: "1.5.0", expectRevision: revision },
    });
    process.send({ result });
  } finally {
    await assembly.close();
    process.disconnect();
  }
});
