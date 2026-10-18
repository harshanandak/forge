import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [installed, root, mode = "all"] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(join(installed, "dist/src", file)).href);
mkdirSync(root, { recursive: true });
const { ForgeFailure } = await load("contract/failure.js");
const { StateOwner } = await load("core/state/index.js");
const { sqliteStore } = await load("adapters/store-sqlite/index.js");
const { createStateClient } = await load("assembly/state-client.js");
const { nodeRunIsolation } = await load("adapters/node-runtime/isolation.js");
const source = readFileSync(
  join(installed, "dist/src/blocks/work/entry.cjs"),
  "utf8",
);
const opened = await sqliteStore.open({
  path: join(root, "state.sqlite"),
  readOnly: false,
});
assert.ok(opened.ok);
let now = Date.parse("2026-10-18T00:00:00Z");
const state = new StateOwner(opened.handle.value, { now: () => now });
state.initialize();
const isolation = await nodeRunIsolation.open();
assert.ok(isolation.ok);
let sequence = 0;
let readbackFault = false;
const actor = (name) => ({ kind: "agent", id: name });
const context = (who, generation, session = who) => ({
  variant: "leased",
  leaseMode: generation === "acquire" ? "acquire" : "held",
  actor: actor(who),
  session: { id: session },
  project: { id: root },
  ...(generation === "acquire" ? {} : { leaseGeneration: generation }),
});
function call(
  op,
  input = {},
  ctx = { variant: "project", actor: actor("alice"), project: { id: root } },
  requestId = `r-${++sequence}`,
) {
  const client = createStateClient({
    owner: state,
    namespace: "forge/work",
    context: ctx,
    write: ![
      "show",
      "list",
      "ready",
      "blocked",
      "stale",
      "comments",
      "events",
      "links",
      "lint",
    ].includes(op),
    requestId,
  });
  const encoded = isolation.handle.value.run({
    source,
    filename: "entry.cjs",
    operation: `issue.${op}`,
    args: {
      input,
      services: {
        state: {
          ...client,
          now: () => now,
          ...(readbackFault ? { get: () => undefined } : {}),
        },
      },
    },
    encode: JSON.stringify,
    fail: (code, message) => {
      throw new ForgeFailure({ code, message, retry: "never" });
    },
    timeoutMs: 1000,
  });
  return JSON.parse(encoded);
}
function error(code, fn) {
  assert.throws(
    fn,
    (failure) => failure instanceof ForgeFailure && failure.error.code === code,
    `expected ${code}`,
  );
}
function create(title = "A task") {
  return call("create", { title, kind: "task" });
}
try {
  if (["all", "records"].includes(mode)) {
    const item = create();
    assert.equal(item.title, "A task");
    assert.deepEqual(call("show", { id: item.id }), item);
    const comment = call("comment", {
      id: item.id,
      body: "plain text: stage: dev -> review",
    });
    const read = call("comments", { id: item.id }).records[0];
    assert.equal(read.key, comment.commentId);
    assert.equal(read.value.body, "plain text: stage: dev -> review");
    assert.deepEqual(read.updatedBy, actor("alice"));
    assert.deepEqual(
      call("ready").items.map((x) => x.id),
      [item.id],
    );
    const grant = call("claim", { id: item.id }, context("alice", "acquire"));
    const updated = call(
      "update",
      { id: item.id, title: "Changed", expectRevision: item.revision },
      context("alice", grant.generation),
    );
    assert.equal(updated.title, "Changed");
    error("REVISION_CONFLICT", () =>
      call(
        "update",
        { id: item.id, title: "lost", expectRevision: 1 },
        context("alice", grant.generation),
      ),
    );
    call(
      "link",
      { id: item.id, relation: "source", url: "https://example.com/task" },
      context("alice", grant.generation),
    );
    assert.equal(
      call("links", { id: item.id }).records[0].value.url,
      "https://example.com/task",
    );
    const closed = call(
      "close",
      { id: item.id, reason: "accepted" },
      context("alice", grant.generation),
    );
    assert.equal(closed.status, "closed");
    assert.deepEqual(call("show", { id: item.id }), closed);
    assert.equal(call("ready").items.length, 0);
    assert.equal(
      call("events", { id: item.id }).events.at(-1).data.closeReason,
      "accepted",
    );
    error("INPUT_INVALID", () =>
      call("create", { title: "unknown", kind: "mystery" }),
    );
    assert.deepEqual(call("lint").problems, []);
    readbackFault = true;
    try {
      error("INTERNAL", () => create("Readback fault"));
    } finally {
      readbackFault = false;
    }
    console.log(
      "PASS records: create, comment readback, update CAS, links, close readback, unknown kind",
    );
  }
  if (["all", "leases"].includes(mode)) {
    const item = create("Leases");
    const ref = { id: item.id, ttlSeconds: 10 };
    // Controlled schedule: both actors observe the same unleased subject before either transaction.
    assert.equal(state.lease("forge/work", `issue:${item.id}`), undefined);
    assert.equal(state.lease("forge/work", `issue:${item.id}`), undefined);
    const first = call("claim", ref, context("alice", "acquire"), "winner");
    assert.equal(first.generation, 1);
    let conflict;
    try {
      call("claim", ref, context("bob", "acquire"));
    } catch (e) {
      conflict = e.error;
    }
    assert.equal(conflict.code, "LEASE_HELD");
    assert.deepEqual(conflict.lease.holder, {
      actor: actor("alice"),
      session: { id: "alice" },
    });
    assert.equal(conflict.lease.generation, 1);
    assert.equal(conflict.lease.expiresAt, first.expiresAt);
    assert.deepEqual(
      call("claim", ref, context("alice", "acquire"), "winner"),
      first,
    );
    assert.equal(
      call("ready").items.some((x) => x.id === item.id),
      false,
    );
    now += 1000;
    const renewal = call("renew", ref, context("alice", 1));
    assert.equal(renewal.generation, 1);
    assert.ok(Date.parse(renewal.expiresAt) > Date.parse(first.expiresAt));
    error("CONTEXT_MISSING", () =>
      call("renew", ref, context("alice", undefined)),
    );
    error("LEASE_STALE", () => call("renew", ref, context("alice", 2)));
    error("LEASE_NOT_HELD", () =>
      call("renew", ref, context("alice", 1, "other-session")),
    );
    error("LEASE_HELD", () => call("claim", ref, context("bob", "acquire")));
    now = Date.parse(renewal.expiresAt);
    error("LEASE_EXPIRED", () => call("renew", ref, context("alice", 1)));
    assert.equal(
      call("ready").items.some((x) => x.id === item.id),
      true,
      "expired lease must not hide ready work",
    );
    assert.equal(call("show", { id: item.id }).lease, undefined);
    assert.equal(
      call("stale").items.some((x) => x.id === item.id),
      true,
    );
    for (const op of ["update", "close"])
      error("LEASE_EXPIRED", () =>
        call(
          op,
          { id: item.id, title: "expired", expectRevision: 1 },
          context("alice", 1),
        ),
      );
    const second = call("claim", ref, context("bob", "acquire"));
    assert.equal(
      second.generation,
      2,
      "K2: expired lease must retain its generation",
    );
    const event = call("events", { id: item.id }).events.find(
      (x) => x.type === "forge/work:lease.reacquired@1",
    );
    assert.ok(event, "K2: reacquisition needs its event");
    assert.equal(event.data.previous.generation, 1);
    assert.equal(event.data.previous.holder.actor.id, "alice");
    for (const op of ["renew", "update", "close"])
      error("LEASE_STALE", () =>
        call(
          op,
          { id: item.id, expectRevision: 1, title: "stale" },
          context("alice", 1),
        ),
      );
    call("release", { id: item.id }, context("bob", 2));
    assert.equal(
      call("ready").items.some((x) => x.id === item.id),
      true,
    );
    const third = call("claim", ref, context("alice", "acquire"));
    assert.equal(third.generation, 3);
    now = Date.parse(third.expiresAt);
    const same = call("claim", ref, context("alice", "acquire"));
    assert.equal(same.generation, 4);
    error("LEASE_STALE", () =>
      call("close", { id: item.id }, context("alice", 3)),
    );
    console.log(
      "PASS leases: initial, competing first claimants, replay, renewal errors, expiry, K2 reacquisition, fencing, release, same-holder reacquisition",
    );
  }
  if (["all", "dependencies"].includes(mode)) {
    const parent = create("Parent");
    const child = call("create", {
      title: "Child",
      dependsOn: [parent.id],
      parent: parent.id,
    });
    assert.equal(
      call("ready").items.some((x) => x.id === child.id),
      false,
    );
    assert.equal(
      call("blocked").items.some((x) => x.id === child.id),
      true,
    );
    call("claim", { id: parent.id }, context("alice", "acquire"));
    error("INPUT_CONFLICT", () =>
      call(
        "dep",
        { id: parent.id, target: child.id, action: "add", expectRevision: 1 },
        context("alice", 1),
      ),
    );
    call("close", { id: parent.id }, context("alice", 1));
    assert.equal(
      call("ready").items.some((x) => x.id === child.id),
      true,
    );
    error("NOT_FOUND", () =>
      call("create", { title: "Missing dependency", dependsOn: ["absent"] }),
    );
    console.log(
      "PASS dependencies: blocking, cycle refusal, closure readback and missing reference refusal",
    );
  }
} finally {
  await isolation.handle.close();
  await opened.handle.close();
}
