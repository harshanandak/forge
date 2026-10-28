import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(process.env.FORGE_MEMORY_READBACK_ROOT);
assert.equal(resolve(process.cwd()), root);
assert.ok(basename(root).startsWith("forge-memory-readback-"));
assert.equal(resolve(process.env.FORGE_DEVICE_ROOT), join(root, "device"));
const mode = process.env.FORGE_MEMORY_READBACK_FAULT ?? "drop";
assert.ok(["drop", "text", "tags", "scope", "audit"].includes(mode));
const { StateOwner } = await import(
  new URL("../../../dist/src/core/state/index.js", import.meta.url)
);
function change(value) {
  // In-place mutation also challenges callers that retain only an alias to their intended value.
  return Object.assign(value, {
    [mode]:
      mode === "text"
        ? "altered text"
        : mode === "tags"
          ? ["altered"]
          : "altered",
  });
}
function audit(owner, namespace, key) {
  appendFileSync(
    join(root, "persisted-note.log"),
    `${JSON.stringify(owner.get(namespace, key)?.value)}\n`,
  );
}
function mark(operation) {
  appendFileSync(join(root, "altered-note.log"), `${operation} ${mode}\n`);
}
const put = StateOwner.prototype.put;
StateOwner.prototype.put = function (namespace, key, value, actor, options) {
  if (
    namespace !== "forge/memory" ||
    !key.startsWith("note/") ||
    mode === "drop"
  )
    return put.call(this, namespace, key, value, actor, options);
  if (mode !== "audit") mark("edit");
  const record = put.call(
    this,
    namespace,
    key,
    mode === "audit" ? value : change(value),
    actor,
    options,
  );
  if (mode === "audit") audit(this, namespace, key);
  return record;
};
const putMany = StateOwner.prototype.putMany;
StateOwner.prototype.putMany = function (namespace, entries, actor, options) {
  if (
    namespace !== "forge/memory" ||
    !entries.some((entry) => entry.key.startsWith("note/"))
  )
    return putMany.call(this, namespace, entries, actor, options);
  if (mode === "drop") {
    appendFileSync(join(root, "dropped-note.log"), "dropped\n");
    // Return convincing commit records without persisting the batch.
    return entries.map((entry) => ({
      namespace,
      key: entry.key,
      value: structuredClone(entry.value),
      revision: entry.expectRevision + 1,
      updatedAt: "2026-10-18T00:00:00Z",
      updatedBy: actor,
    }));
  }
  if (mode !== "audit") mark("add");
  const changed = entries.map((entry) =>
    entry.key.startsWith("note/") && mode !== "audit"
      ? { ...entry, value: change(entry.value) }
      : entry,
  );
  const records = putMany.call(this, namespace, changed, actor, options);
  if (mode === "audit")
    for (const entry of entries)
      if (entry.key.startsWith("note/")) audit(this, namespace, entry.key);
  return records;
};
