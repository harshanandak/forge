import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { issueStoreSnapshot } from "./issue-command-storage.fixture.ts";

export const authorityDiagnostic = (operation: string) =>
  `Authority invariant missing or failed for ${operation}: add this entry point to the shared contract suite and test refusal before state changes.`;

export function requireAuthorityCoverage(
  writers: readonly string[],
  cases: readonly string[],
) {
  const available = new Set(writers);
  const covered = new Set<string>();
  if (available.size === 0)
    throw new Error(authorityDiagnostic("issue writers"));
  for (const operation of cases) {
    if (!available.has(operation) || covered.has(operation))
      throw new Error(authorityDiagnostic(operation));
    covered.add(operation);
  }
  for (const operation of available)
    if (!covered.has(operation))
      throw new Error(authorityDiagnostic(operation));
}

export function observeAuthorityStore(
  db: Database,
  values: ReadonlyMap<string, unknown>,
) {
  const snapshot = () => issueStoreSnapshot(db, values);
  const business = () => [
    ...db
      .query(
        "SELECT * FROM state_records WHERE namespace='forge/work' ORDER BY key",
      )
      .all(),
    ...db
      .query(
        "SELECT * FROM state_leases WHERE namespace='forge/work' ORDER BY subject",
      )
      .all(),
  ];
  const receipts = () =>
    db
      .query(
        "SELECT * FROM domain_cloud_command_receipts WHERE outcome='ok' ORDER BY request_id",
      )
      .all();
  let writes = 0;
  let faultBase: ReturnType<typeof business> | undefined;
  let injected = false;
  return {
    snapshot,
    business,
    receipts,
    writes: () => writes,
    beforeSql(sql: string) {
      if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP)\b/i.test(sql))
        writes++;
      if (
        faultBase !== undefined &&
        sql.startsWith("INSERT INTO domain_cloud_command_receipts")
      ) {
        expect(business()).not.toEqual(faultBase);
        injected = true;
        throw new Error("SQLITE_FULL");
      }
    },
    async failReceipt<T>(submit: () => Promise<T>) {
      faultBase = business();
      try {
        const reply = await submit();
        expect(injected).toBe(true);
        return reply;
      } finally {
        faultBase = undefined;
      }
    },
  };
}

type Refusal = readonly [status: number, code: string];
type Reply = readonly [status: number, code: string | undefined];

export interface AuthorityFixture {
  store: ReturnType<typeof observeAuthorityStore>;
  submit: () => Promise<Reply>;
  unauthorized: readonly [() => Promise<Reply>, Refusal];
  competingHolder?: readonly [() => Promise<Reply>, Refusal];
  race: (markCompetitorCommitted: () => void) => Promise<Reply>;
  raceRefusal: Refusal;
  close: () => void;
}

export async function runAuthorityContract(
  prepare: () => Promise<AuthorityFixture>,
) {
  const fixture = await prepare();
  const { store, submit, unauthorized, competingHolder } = fixture;
  const checkRefusal = async ([send, expected]: readonly [
    () => Promise<Reply>,
    Refusal,
  ]) => {
    const before = store.snapshot();
    const writes = store.writes();
    expect(await send()).toEqual(expected);
    expect(store.writes()).toBe(writes);
    expect(store.snapshot()).toBe(before);
  };
  try {
    await checkRefusal(unauthorized);
    if (competingHolder !== undefined) await checkRefusal(competingHolder);

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
    let afterCompetitor: string | undefined;
    let afterWrites: number | undefined;
    expect(
      await other.race(() => {
        expect(afterCompetitor).toBeUndefined();
        afterCompetitor = other.store.snapshot();
        afterWrites = other.store.writes();
      }),
    ).toEqual(other.raceRefusal);
    expect(afterCompetitor).toBeDefined();
    expect(other.store.writes()).toBe(afterWrites!);
    expect(other.store.snapshot()).toBe(afterCompetitor!);
  } finally {
    other.close();
  }
}
