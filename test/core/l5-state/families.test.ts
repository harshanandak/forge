import { test, setDefaultTimeout } from "bun:test";
import { deepStrictEqual as eq, throws } from "node:assert/strict";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";

setDefaultTimeout(30_000);
const actor = { kind: "agent", id: "families" } as const;
const ns = "example/alpha";
const clock = { now: () => 1000 };
const text = (_key: string, value: unknown) =>
  typeof value === "string" ? undefined : "NOTE_VALUE";
const policies = () => [
  {
    namespace: ns,
    families: {
      note: { key: /^note:[a-z]+$/, admit: text },
      entry: { key: /^entry:[1-9][0-9]*$/, admit: text },
      allocation: { key: /^allocation:entry:$/, admit: () => undefined },
    },
  },
  {
    namespace: "example/beta",
    families: {
      job: {
        key: /^job:[1-9][0-9]*$/,
        admit: (_key: string, value: unknown) =>
          Number.isSafeInteger(value) ? undefined : "JOB_VALUE",
      },
    },
  },
];
const enrolled = (db: SqlDatabase, declarations = policies()): StateOwner =>
  Reflect.construct(StateOwner, [db, clock, declarations]) as StateOwner;
async function open() {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const db = result.handle.value;
  const owner = new StateOwner(db, clock);
  owner.initialize();
  return { db, owner, close: () => result.handle.close() };
}
const snapshot = (db: SqlDatabase) =>
  JSON.stringify(
    ["state_records", "state_events", "state_requests", "state_retention"].map(
      (table) => db.all(`SELECT * FROM ${table}`),
    ),
  );

test.each([
  [ns, "note:one", "text"],
  ["example/beta", "job:1", 1],
] as const)(
  "family enforcement is generic in %s",
  async (namespace, key, value) => {
    const f = await open();
    try {
      const owner = enrolled(f.db);
      eq(
        owner.put(namespace, key, value, actor, { expectRevision: 0 }).value,
        value,
      );
      const before = snapshot(f.db);
      throws(
        () =>
          owner.put(namespace, "future:one", value, actor, {
            expectRevision: 0,
          }),
        /STATE_FAMILY_UNDECLARED/,
      );
      eq(snapshot(f.db), before);
    } finally {
      await f.close();
    }
  },
);

test.each(["put", "putMany", "putNext", "delete"] as const)(
  "undeclared %s refuses without records, events, receipts or floor changes",
  async (method) => {
    const f = await open();
    try {
      f.owner.put(ns, "future:one", "old", actor, { expectRevision: 0 });
      const owner = enrolled(f.db),
        before = snapshot(f.db);
      const write = {
        put: () =>
          owner.put(ns, "future:two", "new", actor, {
            expectRevision: 0,
            requestId: "refused",
          }),
        putMany: () =>
          owner.putMany(
            ns,
            [
              { key: "note:one", value: "valid", expectRevision: 0 },
              { key: "future:two", value: "new", expectRevision: 0 },
            ],
            actor,
          ),
        putNext: () =>
          owner.putNext(ns, "future:", () => ({ value: "new" }), actor),
        delete: () =>
          owner.delete(ns, "future:one", actor, { expectRevision: 1 }),
      };
      throws(write[method], /STATE_FAMILY_UNDECLARED/);
      eq(owner.get(ns, "future:one")?.value, "old");
      eq(snapshot(f.db), before);
    } finally {
      await f.close();
    }
  },
);

test.each(["put", "putMany", "putNext"] as const)(
  "declared %s applies the family's value admission atomically",
  async (method) => {
    const f = await open();
    try {
      const owner = enrolled(f.db),
        before = snapshot(f.db);
      const write = {
        put: () =>
          owner.put(ns, "note:one", false, actor, { expectRevision: 0 }),
        putMany: () =>
          owner.putMany(
            ns,
            [
              { key: "note:one", value: "valid", expectRevision: 0 },
              { key: "note:two", value: false, expectRevision: 0 },
            ],
            actor,
          ),
        putNext: () =>
          owner.putNext(ns, "entry:", () => ({ value: false }), actor),
      };
      throws(write[method], /NOTE_VALUE/);
      eq(snapshot(f.db), before);
    } finally {
      await f.close();
    }
  },
);

test("numbered keys and generated allocation records both require declaration before the builder", async () => {
  const f = await open();
  try {
    for (const missing of ["entry", "allocation"] as const) {
      const declarations = policies();
      const first = declarations[0]!;
      if (!first.families.entry || !first.families.allocation)
        throw new Error("fixture");
      first.families[missing].key = /^never$/;
      const owner = enrolled(f.db, declarations),
        before = snapshot(f.db);
      let built = false;
      throws(
        () =>
          owner.putNext(
            ns,
            "entry:",
            () => {
              built = true;
              return { value: "valid" };
            },
            actor,
          ),
        /STATE_FAMILY_UNDECLARED/,
      );
      eq(built, false);
      eq(snapshot(f.db), before);
    }
  } finally {
    await f.close();
  }
});

test("declared numbered writes and deletion preserve the ordinary allocation protocol", async () => {
  const f = await open();
  try {
    const owner = enrolled(f.db);
    const first = owner.putNext(
      ns,
      "entry:",
      () => ({ value: "first" }),
      actor,
    );
    eq(first.key, "entry:1");
    owner.delete(ns, first.key, actor, { expectRevision: 1 });
    eq(
      owner.putNext(ns, "entry:", () => ({ value: "second" }), actor).key,
      "entry:2",
    );
    eq(owner.get(ns, "allocation:entry:")?.value, {
      prefix: "entry:",
      number: 2,
    });
  } finally {
    await f.close();
  }
});

test("a cached put cannot replay past the current family declaration", async () => {
  const f = await open();
  try {
    const options = { expectRevision: 0, requestId: "old-request" };
    f.owner.put(ns, "future:one", "old", actor, options);
    const before = snapshot(f.db);
    throws(
      () => enrolled(f.db).put(ns, "future:one", "old", actor, options),
      /STATE_FAMILY_UNDECLARED/,
    );
    eq(snapshot(f.db), before);
  } finally {
    await f.close();
  }
});

test("registry snapshots resist later declaration mutation", async () => {
  const f = await open();
  try {
    const declarations = policies(),
      owner = enrolled(f.db, declarations);
    const row = declarations[0]!.families.note!;
    row.key = /.*/;
    row.admit = () => undefined;
    throws(
      () => owner.put(ns, "future:one", "valid", actor, { expectRevision: 0 }),
      /STATE_FAMILY_UNDECLARED/,
    );
    throws(
      () => owner.put(ns, "note:one", false, actor, { expectRevision: 0 }),
      /NOTE_VALUE/,
    );
  } finally {
    await f.close();
  }
});

test("matching requires the entire key and refuses overlapping families", async () => {
  const f = await open();
  try {
    const declarations = policies();
    declarations[0]!.families.entry!.key = /^note:/;
    const owner = enrolled(f.db, declarations);
    throws(
      () => owner.put(ns, "note:one\n", "valid", actor, { expectRevision: 0 }),
      /STATE_FAMILY_UNDECLARED/,
    );
    declarations[0]!.families.entry!.key = /^note:[a-z]+$/;
    throws(
      () =>
        enrolled(f.db, declarations).put(ns, "note:one", "valid", actor, {
          expectRevision: 0,
        }),
      /STATE_FAMILY_AMBIGUOUS/,
    );
    eq(owner.list(ns), []);
  } finally {
    await f.close();
  }
});

test.each(["g", "y"])(
  "stateful key flag %s is refused at enrollment",
  async (flag) => {
    const f = await open();
    try {
      const declarations = policies();
      declarations[0]!.families.note!.key = new RegExp("^note:[a-z]+$", flag);
      throws(() => enrolled(f.db, declarations), /STATE_FAMILY_DECLARATION/);
    } finally {
      await f.close();
    }
  },
);

test("namespaces not enrolled retain their current behavior", async () => {
  const f = await open();
  try {
    const owner = enrolled(f.db);
    for (const namespace of [
      "forge/check",
      "forge/memory",
      "forge/core-project",
    ])
      eq(
        owner.put(namespace, "unrestricted", null, actor, { expectRevision: 0 })
          .value,
        null,
      );
  } finally {
    await f.close();
  }
});
