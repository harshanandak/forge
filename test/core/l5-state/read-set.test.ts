import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";

const namespace = "io.example/rules";
const actor = { kind: "agent" as const, id: "reader" };

test("read-set barrier refuses a changed dependency without accepting a write or event", async () => {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  let locked = false;
  const reads: boolean[] = [];
  const db = opened.handle.value;
  const owner = new StateOwner(
    {
      ...db,
      get(sql, params) {
        if (sql.includes("FROM state_records") && params?.[1] === "dependency")
          reads.push(locked);
        return db.get(sql, params);
      },
      transaction<T>(work: () => T): T {
        return db.transaction(() => {
          locked = true;
          try {
            return work();
          } finally {
            locked = false;
          }
        });
      },
    },
    { now: () => 1000 },
  );
  const other = new StateOwner(db, { now: () => 1000 });
  try {
    owner.initialize();
    owner.put(namespace, "dependency", { enabled: true }, actor, {
      expectRevision: 0,
    });
    let announce!: () => void;
    let resume!: () => void;
    const observed = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pending = (async () => {
      const dependency = owner.get(namespace, "dependency")!;
      announce();
      await barrier;
      const options = {
        expectRevision: 0,
        requestId: "guarded-write",
        readSet: [{ key: dependency.key, expectRevision: dependency.revision }],
      };
      try {
        owner.put(namespace, "accepted", { enabled: true }, actor, options);
        return undefined;
      } catch (failure) {
        return failure;
      }
    })();
    await observed;
    other.put(
      namespace,
      "dependency",
      { enabled: false },
      { kind: "agent", id: "writer" },
      { expectRevision: 1 },
    );
    const before = owner.export();
    reads.length = 0;
    resume();
    const failure = await pending;
    expect(failure).toBeInstanceOf(ForgeFailure);
    expect((failure as ForgeFailure).error).toMatchObject({
      code: "REVISION_CONFLICT",
      currentRevision: 2,
    });
    expect(reads).toEqual([true]);
    expect(owner.get(namespace, "accepted")).toBeUndefined();
    expect(owner.export()).toEqual(before);
  } finally {
    await opened.handle.close();
  }
}, 30000);

test("request identity includes the read set and exact replays survive later changes", async () => {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  try {
    const owner = new StateOwner(opened.handle.value, { now: () => 1000 });
    owner.initialize();
    owner.put(namespace, "dependency", true, actor, { expectRevision: 0 });
    const options = {
      expectRevision: 0,
      requestId: "read-set-identity",
      readSet: [{ key: "dependency", expectRevision: 1 }],
    };
    const accepted = owner.put(namespace, "accepted", true, actor, options);
    owner.put(namespace, "dependency", false, actor, { expectRevision: 1 });
    const before = owner.export();
    expect(owner.put(namespace, "accepted", true, actor, options)).toEqual(
      accepted,
    );
    let failure: unknown;
    try {
      owner.put(namespace, "accepted", true, actor, {
        ...options,
        readSet: [{ key: "dependency", expectRevision: 2 }],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ForgeFailure);
    expect((failure as ForgeFailure).error.code).toBe("INPUT_CONFLICT");
    expect(owner.export()).toEqual(before);
  } finally {
    await opened.handle.close();
  }
}, 30000);

test("matching and absent read-set revisions permit a generic write", async () => {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  try {
    const owner = new StateOwner(opened.handle.value, { now: () => 1000 });
    owner.initialize();
    const dependency = owner.put(namespace, "dependency", true, actor, {
      expectRevision: 0,
    });
    const options = {
      expectRevision: 0,
      readSet: [
        { key: "dependency", expectRevision: dependency.revision },
        { key: "absent", expectRevision: 0 },
      ],
    };
    expect(
      owner.put(namespace, "accepted", true, actor, options).revision,
    ).toBe(1);
    expect(owner.get(namespace, "accepted")?.value).toBe(true);
  } finally {
    await opened.handle.close();
  }
}, 30000);

test("restore checks read-set receipts against history before their write", async () => {
  const source = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  const target = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  const rejected = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!source.ok || !target.ok || !rejected.ok)
    throw new Error("SQLite unavailable");
  try {
    const owner = new StateOwner(source.handle.value, { now: () => 1000 });
    const restored = new StateOwner(target.handle.value, { now: () => 1000 });
    owner.initialize();
    restored.initialize();
    owner.put(namespace, "dependency", true, actor, {
      expectRevision: 0,
      requestId: "unguarded",
    });
    const options = {
      expectRevision: 0,
      requestId: "guarded",
      readSet: [{ key: "dependency", expectRevision: 1 }],
    };
    const accepted = owner.put(namespace, "accepted", true, actor, options);
    owner.put(namespace, "dependency", false, actor, { expectRevision: 1 });
    restored.restore(owner.export());
    expect(restored.put(namespace, "accepted", true, actor, options)).toEqual(
      accepted,
    );
    const empty = new StateOwner(rejected.handle.value, { now: () => 1000 });
    empty.initialize();
    const before = empty.export();
    const row = source.handle.value.get(
      "SELECT fingerprint FROM state_requests WHERE namespace=? AND request_id=?",
      [namespace, "guarded"],
    )!;
    const input = JSON.parse(String(row.fingerprint)) as {
      readSet: { key: string; expectRevision: number }[];
    };
    input.readSet[0]!.expectRevision = 2;
    const canonical = JSON.stringify(input, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value,
    );
    source.handle.value.run(
      "UPDATE state_requests SET fingerprint=? WHERE namespace=? AND request_id=?",
      [canonical, namespace, "guarded"],
    );
    expect(() => empty.restore(owner.export())).toThrow(
      "Inconsistent imported state_requests",
    );
    expect(empty.export()).toEqual(before);
  } finally {
    await source.handle.close();
    await target.handle.close();
    await rejected.handle.close();
  }
}, 30000);
