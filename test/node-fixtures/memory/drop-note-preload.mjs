import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(process.env.FORGE_MEMORY_READBACK_ROOT);
assert.equal(resolve(process.cwd()), root);
assert.ok(basename(root).startsWith("forge-memory-readback-"));
assert.equal(resolve(process.env.FORGE_DEVICE_ROOT), join(root, "device"));
const { StateOwner } = await import(
  new URL("../../../dist/src/core/state/index.js", import.meta.url)
);
const putMany = StateOwner.prototype.putMany;
StateOwner.prototype.putMany = function (namespace, entries, actor, options) {
  if (
    namespace !== "forge/memory" ||
    !entries.some((entry) => entry.key.startsWith("note/"))
  )
    return putMany.call(this, namespace, entries, actor, options);
  appendFileSync(join(root, "dropped-note.log"), "dropped\n");
  // Return the same convincing records as a durable commit, without persisting the batch.
  return entries.map((entry) => ({
    namespace,
    key: entry.key,
    value: structuredClone(entry.value),
    revision: entry.expectRevision + 1,
    updatedAt: "2026-10-18T00:00:00Z",
    updatedBy: actor,
  }));
};
