import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  StateOwner,
  type Snapshot,
  type StateImageStore,
} from "../../../src/core/state/index.ts";

const actor = { kind: "agent" as const, id: "restore-lease-pages" };
const holder = { actor, session: { id: "session" } };
const defaultPageSize = 16;
// Sorted by (namespace, subject), so insertion order and key order agree.
const namespaces = ["forge/other", "forge/test"];
const perNamespace = 10;

// The optional page size keeps this tests-first commit type-correct with the old restore.
interface PagedRestore {
  restore(
    snapshot: Snapshot,
    verifyRecovery?: () => void,
    pageSize?: number,
  ): void;
}
const restoreWith = (
  owner: StateOwner,
  snapshot: Snapshot,
  pageSize?: number,
): void =>
  (owner as unknown as PagedRestore).restore(snapshot, undefined, pageSize);

async function open(now: number) {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const db = opened.handle.value as StateImageStore;
  const owner = new StateOwner(db, { now: () => now });
  owner.initialize();
  return { db, owner, close: () => opened.handle.close() };
}

/** More leases than any tested page; every third is expired, held or released at restore time. */
async function source() {
  const opened = await open(1000);
  let index = 0;
  for (const namespace of namespaces)
    for (let n = 0; n < perNamespace; n++, index++) {
      const subject = `lease-${String(n).padStart(2, "0")}`;
      const expired = index % 3 === 0;
      const lease = opened.owner.acquire(
        namespace,
        subject,
        holder,
        expired ? 100 : 100_000,
        `claim-${index}`,
      );
      if (index % 3 === 2)
        opened.owner.release(namespace, {
          subject,
          holder,
          generation: lease.generation,
        });
    }
  return { ...opened, snapshot: opened.owner.export() };
}

async function restored(snapshot: Snapshot, pageSize?: number) {
  const target = await open(2000);
  try {
    restoreWith(target.owner, snapshot, pageSize);
    const exported = target.owner.export();
    return { leases: exported.leases, events: exported.events };
  } finally {
    await target.close();
  }
}

for (const pageSize of [1, 2, undefined]) {
  const label = pageSize ?? "default";

  test(`restore expires live leases and writes the same events, page size ${label}`, async () => {
    const from = await source();
    try {
      const reference = await restored(from.snapshot, 1_000);
      const paged = await restored(from.snapshot, pageSize);
      expect(paged).toEqual(reference);
      // Leases 1, 4, 7... are held and unexpired; only they get an expiry event, in key order.
      const expected = namespaces
        .flatMap((namespace, space) =>
          Array.from({ length: perNamespace }, (_, n) => ({
            namespace,
            key: `lease-${String(n).padStart(2, "0")}`,
            index: space * perNamespace + n,
          })),
        )
        .filter(({ index }) => index % 3 === 1);
      expect(
        paged.events
          .slice(from.snapshot.events.length)
          .map(({ namespace, key }) => ({ namespace, key })),
      ).toEqual(expected.map(({ namespace, key }) => ({ namespace, key })));
      expect(expected.length).toBe(7);
    } finally {
      await from.close();
    }
  }, 30_000);

  test(`restore reads leases in bounded key-ordered pages, page size ${label}`, async () => {
    const from = await source();
    const target = await open(2000);
    const rows: number[] = [];
    const intercepted: StateImageStore = {
      ...target.db,
      restoreImage(image, validate, prepare, verify) {
        target.db.restoreImage(
          image,
          validate,
          (candidate) =>
            prepare({
              ...candidate,
              all(sql, params) {
                if (/\bFROM\s+state_leases\b/i.test(sql)) {
                  // Check before executing: a whole-table read must never allocate its rows.
                  expect(sql).toMatch(/\bORDER\s+BY\b/i);
                  expect(sql).not.toMatch(/\bOFFSET\b/i);
                  const limit = /\bLIMIT\s+(\?|\d+)\s*$/i.exec(sql);
                  expect(limit).not.toBeNull();
                  const bound =
                    limit![1] === "?"
                      ? Number(params?.at(-1))
                      : Number(limit![1]);
                  expect(Number.isSafeInteger(bound)).toBe(true);
                  expect(bound).toBeGreaterThan(0);
                  expect(bound).toBeLessThanOrEqual(
                    pageSize ?? defaultPageSize,
                  );
                  const page = candidate.all(sql, params);
                  rows.push(page.length);
                  return page;
                }
                return candidate.all(sql, params);
              },
            }),
          verify,
        );
      },
    };
    try {
      restoreWith(
        new StateOwner(intercepted, { now: () => 2000 }),
        from.snapshot,
        pageSize,
      );
      expect(rows.length).toBeGreaterThan(1);
      expect(Math.max(...rows)).toBeLessThanOrEqual(
        pageSize ?? defaultPageSize,
      );
      expect(rows.reduce((total, count) => total + count, 0)).toBeGreaterThan(
        namespaces.length * perNamespace - 1,
      );
    } finally {
      await from.close();
      await target.close();
    }
  }, 30_000);
}
