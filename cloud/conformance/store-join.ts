// A nested transaction joins the outer one, and a failed inner body aborts the outer one even if
// the outer code catches the error. Runs with `bun conformance/store-join.ts` against a fake storage.
import assert from "node:assert/strict";
import { durableStore, type DurableStorage } from "../src/store.ts";

function fake(): { storage: DurableStorage; outcomes: string[] } {
  const outcomes: string[] = [];
  const storage: DurableStorage = {
    sql: { exec: () => ({ toArray: () => [] }) },
    get: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
    transactionSync: (body) => {
      try {
        const result = body();
        outcomes.push("commit");
        return result;
      } catch (error) {
        outcomes.push("rollback");
        throw error;
      }
    },
  };
  return { storage, outcomes };
}

{
  const { storage, outcomes } = fake();
  const db = durableStore(storage);
  assert.equal(
    db.transaction(() => db.transaction(() => 7)),
    7,
  );
  assert.deepEqual(outcomes, ["commit"], "one transaction, not two");
}
{
  const { storage, outcomes } = fake();
  const db = durableStore(storage);
  assert.throws(
    () =>
      db.transaction(() => {
        try {
          db.transaction(() => {
            throw new Error("inner");
          });
        } catch {
          // The outer code swallows the inner failure; the outer transaction must still abort.
        }
        return 1;
      }),
    /inner transaction failed/,
  );
  assert.deepEqual(outcomes, ["rollback"]);
  assert.equal(
    db.transaction(() => 2),
    2,
    "the next transaction starts clean",
  );
}
console.log(
  "PASS store joins nested transactions and aborts on an inner failure",
);
