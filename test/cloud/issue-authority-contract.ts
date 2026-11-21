import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { COMMAND_RECEIPTS } from "../../cloud/src/dump.ts";
import { issueStoreSnapshot } from "./issue-command-storage.fixture.ts";

export const authorityDiagnostic = (operation: string) =>
  `Authority invariant missing or failed for ${operation}: add this entry point to the shared contract suite and test refusal before state changes.`;

export function requireAuthorityCoverage(
  writers: readonly string[],
  cases: readonly string[],
) {
  const missing = new Set(writers);
  if (missing.size === 0) throw new Error(authorityDiagnostic("issue writers"));
  for (const operation of cases)
    if (!missing.delete(operation))
      throw new Error(authorityDiagnostic(operation));
  for (const operation of missing)
    throw new Error(authorityDiagnostic(operation));
}

export function observeAuthorityStore(
  db: Database,
  values: ReadonlyMap<string, unknown>,
) {
  const snapshot = () => issueStoreSnapshot(db, values);
  const rows = (sql: string) => db.query(sql).all();
  const business = () => [
    ...rows(
      "SELECT * FROM state_records WHERE namespace='forge/work' ORDER BY key",
    ),
    ...rows(
      "SELECT * FROM state_leases WHERE namespace='forge/work' ORDER BY subject",
    ),
  ];
  const receipts = () =>
    rows(
      `SELECT * FROM ${COMMAND_RECEIPTS} WHERE outcome='ok' ORDER BY request_id`,
    );
  const expiredId = "expired-authority-fixture";
  const expired = () =>
    db
      .query(`SELECT 1 FROM ${COMMAND_RECEIPTS} WHERE request_id=?`)
      .get(expiredId);
  const changes = () =>
    db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  let pruneChanges = 0;
  let fault: (() => never) | undefined;
  return {
    snapshot,
    effects: () => ({ stored: snapshot(), changes: changes(), pruneChanges }),
    business,
    receipts,
    seedExpiredReceipt() {
      db.run(
        `INSERT INTO ${COMMAND_RECEIPTS}(request_id,fingerprint,outcome,result,created_at,expires_at) VALUES (?,'{}','refused',?,1,2)`,
        [
          expiredId,
          JSON.stringify({
            code: "INPUT_INVALID",
            message: "Expired fixture",
            retry: "never",
          }),
        ],
      );
    },
    traceSql<T>(sql: string, apply: () => T): T {
      if (sql.startsWith(`INSERT INTO ${COMMAND_RECEIPTS}`)) fault?.();
      if (!sql.startsWith(`DELETE FROM ${COMMAND_RECEIPTS} `) || !expired())
        return apply();
      const before = changes();
      const result = apply();
      if (!expired()) pruneChanges += changes() - before;
      return result;
    },
    async failReceipt<T>(submit: () => Promise<T>) {
      const before = business();
      let injected = false;
      fault = () => {
        expect(business()).not.toEqual(before);
        injected = true;
        throw new Error("SQLITE_FULL");
      };
      try {
        const reply = await submit();
        expect(injected).toBe(true);
        return reply;
      } finally {
        fault = undefined;
      }
    },
  };
}

type Refusal = readonly [status: number, code: string];
type Reply = readonly [status: number, code: string | undefined];
export type RefusalCase = readonly [() => Promise<Reply>, Refusal];

export interface AuthorityFixture {
  store: ReturnType<typeof observeAuthorityStore>;
  submit: () => Promise<Reply>;
  refusals: readonly RefusalCase[];
  race: (markCompetitorCommitted: () => void) => Promise<Reply>;
  raceRefusal: Refusal;
  close: () => void;
}

export async function runAuthorityContract(
  operation: string,
  prepare: () => Promise<AuthorityFixture>,
) {
  const fixture = await prepare();
  const { store, submit, refusals } = fixture;
  type Effects = ReturnType<typeof store.effects>;
  const checkUnchanged = (code: string, before: Effects, after: Effects) => {
    expect(after.stored).toBe(before.stored);
    const pruned = after.pruneChanges - before.pruneChanges;
    expect(after.changes - before.changes).toBe(pruned);
    console.info(
      `authority contract ${operation} ${code}: expired receipt ${pruned ? "rolled back" : "untouched"}`,
    );
  };
  try {
    store.seedExpiredReceipt();
    for (const [send, expected] of refusals) {
      const before = store.effects();
      expect(await send()).toEqual(expected);
      checkUnchanged(expected[1], before, store.effects());
    }

    const before = store.snapshot();
    expect(await store.failReceipt(submit)).toEqual([
      503,
      "STORAGE_LIMIT_EXCEEDED",
    ]);
    expect(store.snapshot()).toBe(before);

    const business = store.business();
    const receipts = store.receipts();
    expect(await submit()).toEqual([200, undefined]);
    expect(store.business()).not.toEqual(business);
    const after = store.receipts();
    expect(after).toHaveLength(receipts.length + 1);
    for (const receipt of receipts) expect(after).toContainEqual(receipt);
  } finally {
    fixture.close();
  }

  const other = await prepare();
  try {
    other.store.seedExpiredReceipt();
    let afterCompetitor: Effects | undefined;
    const reply = await other.race(() => {
      expect(afterCompetitor).toBeUndefined();
      afterCompetitor = other.store.effects();
    });
    expect(reply).toEqual(other.raceRefusal);
    expect(afterCompetitor).toBeDefined();
    checkUnchanged(
      other.raceRefusal[1],
      afterCompetitor!,
      other.store.effects(),
    );
  } finally {
    other.close();
  }
}
