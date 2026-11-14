import { expect, test } from "bun:test";
import {
  maxSource,
  call,
  tablesOf,
} from "../../cloud/conformance/max-source.ts";
import {
  dumpOf,
  dumpPage,
  limitsFrom,
  parseDump,
} from "../../cloud/src/dump.ts";
import {
  evaluateMergeEvidence,
  type MergeCandidate,
  type MergePolicy,
} from "../../cloud/src/merge-evidence.ts";
import { admit } from "../../cloud/src/issue-receipts.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import { fixture, now } from "./merge-evidence.fixture.ts";

const TABLE = "domain_cloud_evidence_receipts";
const modulePath = "../../cloud/src/evidence-receipts.ts";
type Input = {
  candidate: MergeCandidate;
  policy: MergePolicy;
  repository: { host: "github.com"; owner: string; repo: string };
  verifierVersion: string;
  actor: string;
  device: string;
};
type Receipt = Input & {
  format: "forge.cloud-evidence-receipt/1";
  id: string;
  origin: "verified" | "imported";
  subjectKind: "merge-commit";
};
interface Store {
  put(input: Input, id?: string): Receipt;
  get(project: string, issue: string, id: string): Receipt;
}
interface Module {
  EvidenceReceiptStore: new (db: SqlDatabase, project: string) => Store;
  decodeEvidence(text: string): Receipt;
  evidenceEligible(receipt: Receipt): boolean;
}
const code = (action: () => unknown, expected: string) => {
  try {
    action();
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    expect((error as ForgeFailure).error.code).toBe(expected);
  }
};
async function setup() {
  const source = await maxSource("forge");
  try {
    // Missing persistence is the red assertion, before loading the new store API.
    expect(
      source.db.query("SELECT name FROM sqlite_master WHERE name=?").get(TABLE),
    ).not.toBeNull();
    const api = (await import(modulePath)) as Module;
    let writes = 0;
    const db: SqlDatabase = {
      exec: (sql) => {
        writes++;
        source.db.run(sql);
      },
      run: (sql, args = []) => {
        writes++;
        return source.db.query(sql).run(...(args as never[]));
      },
      all: (sql, args = []) =>
        source.db.query(sql).all(...(args as never[])) as SqlRow[],
      get: (sql, args = []) =>
        (source.db.query(sql).get(...(args as never[])) ?? undefined) as
          SqlRow | undefined,
      transaction: (body) => source.db.transaction(body)(),
    };
    const f = fixture();
    const evaluated = evaluateMergeEvidence(
      f.policy,
      f.expected,
      f.observation,
      now,
    );
    if (!evaluated.eligible) throw new Error("Invalid evidence fixture");
    const input: Input = {
      candidate: evaluated.candidate,
      policy: f.policy,
      repository: { host: "github.com", owner: "harshanandak", repo: "forge" },
      verifierVersion: "1",
      actor: "builder",
      device: "laptop",
    };
    return {
      ...source,
      dbSource: source.db,
      api,
      db,
      input,
      store: new api.EvidenceReceiptStore(db, "forge"),
      writes: () => writes,
    };
  } catch (error) {
    source.db.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof setup>>;
type Row = readonly [string, (f: Fixture) => void | Promise<void>];
const rows: Row[] = [
  [
    "stored policy width refuses in decoder",
    (f) => {
      const receipt = f.store.put(f.input);
      Object.assign(receipt.policy, {
        requiredChecks: Array.from({ length: 257 }, (_, i) => `${i}`),
      });
      f.db.run(`UPDATE ${TABLE} SET body=? WHERE id=?`, [
        JSON.stringify(receipt),
        receipt.id,
      ]);
      const read = () => f.store.get("forge", "work-1248", receipt.id);
      code(read, "RECEIPT_INVALID");
      expect(read).toThrow("RECEIPT_INVALID");
    },
  ],
  [
    "immutable round trip and detached copies",
    (f) => {
      const receipt = f.store.put(f.input);
      expect(receipt.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(receipt.origin).toBe("verified");
      expect(f.api.evidenceEligible(receipt)).toBe(true);
      const body = String(
        f.db.get(`SELECT body FROM ${TABLE} WHERE id=?`, [receipt.id])!.body,
      );
      const reads = f.writes();
      expect(f.api.decodeEvidence(body)).toEqual(receipt);
      expect(f.store.get("forge", "work-1248", receipt.id)).toEqual(receipt);
      expect(f.store.put(structuredClone(f.input), receipt.id)).toEqual(
        receipt,
      );
      expect(f.writes()).toBe(reads);
      code(
        () => f.store.put({ ...f.input, actor: "other" }, receipt.id),
        "INPUT_CONFLICT",
      );
      Reflect.set(receipt.candidate.runs[0]!.checks[0]!, "name", "mutated");
      expect(
        String(
          f.db.get(`SELECT body FROM ${TABLE} WHERE id=?`, [receipt.id])!.body,
        ),
      ).toBe(body);
      expect(tablesOf(f.dbSource).state_events).toEqual(f.tables.state_events);
    },
  ],
  ...["issue", "project", "missing"].map((kind): Row => [
    `${kind} lookup refuses without writes`,
    (f) => {
      const receipt = f.store.put(f.input),
        before = f.writes();
      code(
        () =>
          f.store.get(
            kind === "project" ? "other" : "forge",
            kind === "issue" ? "work-9" : "work-1248",
            kind === "missing" ? crypto.randomUUID() : receipt.id,
          ),
        "RECEIPT_INVALID",
      );
      expect(f.writes()).toBe(before);
      expect(f.store.get("forge", "work-1248", receipt.id)).toEqual(receipt);
    },
  ]),
  [
    "imported provenance decodes but never qualifies",
    (f) => {
      const receipt = f.store.put(f.input);
      const imported = { ...receipt, origin: "imported" as const };
      expect(f.api.decodeEvidence(JSON.stringify(imported))).toEqual(imported);
      expect(f.api.evidenceEligible(imported)).toBe(false);
      code(
        () =>
          f.api.decodeEvidence(
            JSON.stringify({ ...receipt, origin: "producer" }),
          ),
        "RECEIPT_INVALID",
      );
    },
  ],
  ...["issue", "project", "bytes"].map((cap): Row => [
    `${cap} cap refuses before any write`,
    (f) => {
      const receipt = f.store.put(f.input);
      if (cap === "bytes") {
        const run = f.input.candidate.runs[0]!;
        f.input.candidate = {
          ...f.input.candidate,
          runs: [
            {
              ...run,
              checks: Array.from({ length: 100 }, (_, i) => ({
                ...run.checks[0]!,
                id: i + 1000,
                name: i === 0 ? "CI Gate" : `extra-${i}`,
              })),
            },
          ],
        };
      } else {
        const count = cap === "issue" ? 7 : 16_383;
        f.db.run(
          `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO ${TABLE}(id,issue_id,body) SELECT 'seed-'||x, ${cap === "issue" ? "'work-1248'" : "'work-'||x"}, ? FROM n`,
          [count, JSON.stringify(receipt)],
        );
      }
      const before = f.writes();
      code(() => f.store.put(f.input), "UNAVAILABLE");
      expect(f.writes()).toBe(before);
      expect(f.store.get("forge", "work-1248", receipt.id)).toEqual(receipt);
    },
  ]),
  ...["expire", "revoke", "sweep"].map((mode): Row => [
    `${mode} leaves evidence unchanged`,
    (f) => {
      const receipt = f.store.put(f.input);
      if (mode === "expire")
        f.db.run("UPDATE domain_cloud_tokens SET expires_at=0");
      if (mode === "revoke")
        f.db.run("UPDATE domain_cloud_tokens SET revoked_at=1");
      if (mode === "sweep") {
        f.db.run("UPDATE domain_cloud_command_receipts SET expires_at=0");
        admit(f.db);
      }
      expect(f.store.get("forge", "work-1248", receipt.id)).toEqual(receipt);
    },
  ]),
  ...[false, true].map((paged): Row => [
    `dump v2 ${paged ? "page" : "whole"} refuses evidence`,
    (f) => {
      expect(parseDump(JSON.stringify(dumpOf(f.db))).format).toBe(
        "forge-cloud-dump/2",
      );
      f.store.put(f.input);
      const before = f.writes();
      code(
        () => (paged ? dumpPage(f.db, "start", limitsFrom({})) : dumpOf(f.db)),
        "INPUT_INVALID",
      );
      expect(f.writes()).toBe(before);
    },
  ]),
  ...["receipt.admit", "receipt.show"].map((op): Row => [
    `${op} is removed and not routed`,
    async (f) => {
      const declarations = manifest.operations as Record<
        string,
        { input: string; output: string }
      >;
      expect(declarations[op]).toBeUndefined();
      const response = await f.send(
        call("receipt-unrouted", op, { id: "forge-1" }),
      );
      expect(JSON.parse(response.text)).toHaveProperty(
        "error.code",
        "UNKNOWN_COMMAND",
      );
      expect(f.db.get(`SELECT COUNT(*) AS n FROM ${TABLE}`)!.n).toBe(0);
    },
  ]),
];
for (const [name, check] of rows)
  test(`evidence receipts: ${name}`, async () => {
    const f = await setup();
    try {
      await check(f);
    } finally {
      f.dbSource.close();
    }
  }, 30_000);
