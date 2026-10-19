import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, mode] = process.argv.slice(2);
const { nodeRunIsolation } = await import(
  pathToFileURL(join(installed, "dist/src/adapters/node-runtime/isolation.js"))
    .href
);
const source = readFileSync(
  join(installed, "dist/src/blocks/work/entry.cjs"),
  "utf8",
);
const opened = await nodeRunIsolation.open();
assert.ok(opened.ok);
const edges = new Map([["work-1", []]]);
let root = "work-1";
for (let diamond = 0; diamond < 25; diamond++) {
  const left = `work-${edges.size + 1}`;
  edges.set(left, [root]);
  const right = `work-${edges.size + 1}`;
  edges.set(right, [root]);
  root = `work-${edges.size + 1}`;
  edges.set(root, [left, right]);
}
const nodes = edges.size;
const edgeCount = [...edges.values()].reduce(
  (sum, next) => sum + next.length,
  0,
);
const bound = nodes + edgeCount + 1;
let reads = 0;
let readsAtWrite;
let listed = 0;
let expansions;
let readsByKey;
let expansionLimit = 1;
let records;
const actor = { kind: "agent", id: "graph-test" };
function reset() {
  reads = listed = 0;
  readsAtWrite = undefined;
  expansions = new Map();
  readsByKey = new Map();
  expansionLimit = 1;
  records = new Map(
    [...edges].map(([id, dependencies]) => [
      `issue:${id}`,
      {
        namespace: "forge/work",
        key: `issue:${id}`,
        revision: 1,
        updatedAt: "2026-10-18T00:00:00Z",
        updatedBy: actor,
        value: {
          id,
          title: id,
          status: "open",
          labels: [],
          createdAt: "2026-10-18T00:00:00Z",
          get dependsOn() {
            const count = (expansions.get(id) ?? 0) + 1;
            expansions.set(id, count);
            if (mode !== "read-count-only")
              assert.ok(
                count <= expansionLimit,
                `graph node expanded more than once: ${id}`,
              );
            return dependencies;
          },
        },
      },
    ]),
  );
}
function call(operation, input = {}) {
  return JSON.parse(
    opened.handle.value.run({
      source,
      filename: "entry.cjs",
      operation: `issue.${operation}`,
      args: {
        input,
        services: {
          state: {
            now: () => Date.parse("2026-10-18T00:00:00Z"),
            get(key) {
              reads++;
              assert.ok(
                reads <= bound,
                `graph reads exceeded bound: ${reads} > ${bound}`,
              );
              if (edges.has(key.slice("issue:".length))) {
                const count = (readsByKey.get(key) ?? 0) + 1;
                readsByKey.set(key, count);
                if (mode !== "read-count-only")
                  assert.ok(
                    count <= 1,
                    `graph record read more than once: ${key}`,
                  );
              }
              return records.get(key);
            },
            list() {
              listed += records.size;
              return [...records.values()];
            },
            lease: () => undefined,
            acquire() {
              throw new Error("unexpected acquire");
            },
            put(key, value, options) {
              readsAtWrite = reads;
              assert.equal(
                new Set(options.readSet.map((read) => read.key)).size,
                options.readSet.length,
              );
              assert.equal(options.readSet.length, nodes);
              const record = {
                namespace: "forge/work",
                key,
                value,
                revision: options.expectRevision + 1,
                updatedAt: "2026-10-18T00:00:00Z",
                updatedBy: actor,
              };
              records.set(key, record);
              return record;
            },
          },
        },
      },
      encode: JSON.stringify,
      fail: (code, message) => {
        throw new Error(`${code}: ${message}`);
      },
      timeoutMs: 1000,
    }),
  );
}
const counts = {};
try {
  for (const operation of [
    "create",
    "update",
    "dep",
    "ready",
    "blocked",
    "lint",
  ]) {
    reset();
    // Listing also copies each returned item's dependencies into its public view.
    if (["ready", "blocked"].includes(operation)) expansionLimit = 2;
    if (["update", "dep"].includes(operation))
      records.set("issue:work-77", {
        namespace: "forge/work",
        key: "issue:work-77",
        revision: 1,
        updatedAt: "2026-10-18T00:00:00Z",
        updatedBy: actor,
        value: {
          id: "work-77",
          title: "source",
          status: "open",
          labels: [],
          dependsOn: [],
          createdAt: "2026-10-18T00:00:00Z",
        },
      });
    const input =
      operation === "create"
        ? { title: "source", dependsOn: [root] }
        : operation === "update"
          ? { id: "work-77", expectRevision: 1, dependsOn: [root] }
          : operation === "dep"
            ? { id: "work-77", expectRevision: 1, action: "add", target: root }
            : {};
    const result = call(operation, input);
    if (operation === "lint") assert.deepEqual(result.problems, []);
    if (operation === "ready")
      assert.deepEqual(
        result.items.map((item) => item.id),
        ["work-1"],
      );
    if (operation === "blocked") assert.equal(result.items.length, nodes - 1);
    assert.ok(reads <= bound);
    assert.ok(listed <= nodes);
    counts[operation] = reads;
    if (operation === "create") {
      assert.ok(readsAtWrite <= nodes + edgeCount);
      counts.validation = readsAtWrite;
    }
  }
  // Close the diamonds into a real cycle; shared descendants must not hide it.
  edges.get("work-1").push(root);
  for (const operation of ["create", "update", "dep", "lint"]) {
    reset();
    if (["update", "dep"].includes(operation))
      records.set("issue:work-77", {
        key: "issue:work-77",
        revision: 1,
        value: {
          id: "work-77",
          title: "source",
          status: "open",
          labels: [],
          dependsOn: [],
        },
      });
    if (operation === "lint") {
      assert.equal(call(operation).problems.length, nodes);
    } else {
      const input =
        operation === "create"
          ? { title: "source", dependsOn: [root] }
          : operation === "update"
            ? { id: "work-77", expectRevision: 1, dependsOn: [root] }
            : { id: "work-77", expectRevision: 1, action: "add", target: root };
      assert.throws(() => call(operation, input), /INPUT_CONFLICT/);
      assert.equal(readsAtWrite, undefined);
    }
    assert.ok(reads <= bound);
  }
  console.log(
    `PASS graph: nodes=${nodes} edges=${edgeCount} bound=${bound} reads=${JSON.stringify(counts)}; real cycles refused`,
  );
} finally {
  await opened.handle.close();
}
