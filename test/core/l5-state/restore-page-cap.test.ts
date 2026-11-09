import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  RestoreConsistencyFailure,
  StateOwner,
  type Snapshot,
  verifyEventDerivedState,
} from "../../../src/core/state/index.ts";
import type { SqlDatabase } from "../../../src/ports/store.ts";

// The documented maximum restore page size. Tests-first commit: the limit is not exported yet.
const pageMax = 1000;
const rejected = [pageMax + 1, Number.MAX_SAFE_INTEGER];
const failure = "Inconsistent imported state_events key high-water mark";

// The optional page size keeps this tests-first commit type-correct with the old code.
const verify: (
  candidate: SqlDatabase,
  highWaterMark: number,
  pageSize?: number,
) => void = verifyEventDerivedState;
interface PagedRestore {
  restore(
    snapshot: Snapshot,
    verifyRecovery?: () => void,
    pageSize?: number,
  ): void;
}

const actor = { kind: "agent" as const, id: "restore-page-cap" };
const holder = { actor, session: { id: "session" } };

async function open() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const db = opened.handle.value;
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
  return { db, owner, close: () => opened.handle.close() };
}

async function filled() {
  const opened = await open();
  opened.owner.acquire("forge/test", "a", holder, 100, "claim-a");
  opened.owner.put("forge/test", "a", "value", actor, {
    expectRevision: 0,
    requestId: "put-a",
  });
  const highWaterMark = Number(
    opened.db.get("SELECT MAX(sequence) AS n FROM state_events")!.n,
  );
  return { ...opened, highWaterMark };
}

for (const pageSize of rejected)
  test(`the verifier rejects page size ${pageSize} as an invalid page size`, async () => {
    const { db, highWaterMark, close } = await filled();
    try {
      let caught: unknown;
      try {
        verify(db, highWaterMark, pageSize);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RestoreConsistencyFailure);
      expect((caught as Error).message).toContain(failure);
    } finally {
      await close();
    }
  }, 30_000);

for (const pageSize of rejected)
  test(`restore rejects page size ${pageSize} as an invalid page size`, async () => {
    const from = await filled();
    const target = await open();
    try {
      const snapshot = from.owner.export();
      expect(() =>
        (target.owner as unknown as PagedRestore).restore(
          snapshot,
          undefined,
          pageSize,
        ),
      ).toThrow(failure);
    } finally {
      await from.close();
      await target.close();
    }
  }, 30_000);

test("the verifier accepts the maximum page size", async () => {
  const { db, highWaterMark, close } = await filled();
  try {
    expect(() => verify(db, highWaterMark, pageMax)).not.toThrow();
  } finally {
    await close();
  }
}, 30_000);

test("restore accepts the maximum page size", async () => {
  const from = await filled();
  const target = await open();
  try {
    const snapshot = from.owner.export();
    expect(() =>
      (target.owner as unknown as PagedRestore).restore(
        snapshot,
        undefined,
        pageMax,
      ),
    ).not.toThrow();
  } finally {
    await from.close();
    await target.close();
  }
}, 30_000);
