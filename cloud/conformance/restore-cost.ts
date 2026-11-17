import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateOwner } from "../../src/core/state/index.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { domain } from "../src/project.ts";
import { durableStore } from "../src/store.ts";
import { dumpPage, limitsFrom } from "../src/dump.ts";
import {
  DUMP,
  FROZEN,
  scratchStorage,
  tablesOf,
  type Tables,
} from "./max-source.ts";
import {
  digests,
  fold,
  problems,
  tally,
  TABLES,
  type Expected,
} from "./digest.ts";
import { stopObservation, stopWindowOf } from "./stop-live.ts";
import { stopPlan } from "./restored.ts";
import type { StatementProfile } from "./write-profile.ts";
import { populateCost } from "./cost-fixture.ts";

const base = process.env.CLOUD_BASE!;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const sizes = [4, 100, 1_000, 8_000];
const limits = limitsFrom({});
const run = `cost-${Date.now()}`;
interface Measurement {
  records: number;
  mode: string;
  pages: number;
  bytes: number;
  sql: number;
  kv: number;
  total: number;
  perRecord: number;
  groups: Record<string, number>;
  statements: StatementProfile[];
}
const results: Measurement[] = [];

async function request(
  target: string,
  route: string,
  body?: unknown,
  profile = false,
) {
  const response = await fetch(`${base}/p/${target}/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${process.env.CLOUD_ADMIN_TOKEN!}`,
      "x-cloud-cold": "1",
      ...(profile ? { "x-cloud-write-profile": "1" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 1_000));
  const writes = ["sql", "kv"].map((kind) => {
    const value = response.headers.get(`x-cloud-${kind}-writes`);
    assert.match(value ?? "", /^\d+$/);
    return Number(value);
  });
  return { body: JSON.parse(text) as unknown, sql: writes[0]!, kv: writes[1]! };
}

function source(records: number) {
  const scratch = scratchStorage();
  const db = durableStore(scratch.storage);
  const owner = new StateOwner(db, { now: () => FROZEN });
  owner.initialize([domain]);
  populateCost(owner, records);
  const tables = tablesOf(scratch.db);
  assert.equal(tables.state_records!.length, records);
  assert.equal(tables.state_events!.length, records);
  const doc = { format: DUMP, tables };
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  assert.ok(bytes <= 8 * 1024 * 1024, `whole restore input is ${bytes} bytes`);
  const pages = [];
  let cursor: string | null = "start";
  while (cursor !== null) {
    const page = dumpPage(db, cursor, limits);
    pages.push(page);
    cursor = page.next;
  }
  const t = tally();
  for (const table of TABLES)
    for (const row of tables[table]!) fold(t, table, row);
  const expected: Expected = {
    floorSupplied: false,
    lastSequence: records,
    tables: digests(t),
  };
  scratch.db.close();
  return { doc, pages, bytes, expected };
}

async function verify(
  target: string,
  original: Tables,
  expected: Expected,
  window: readonly [number, number],
) {
  const status = await request(target, "status");
  assert.deepEqual([status.sql, status.kv], [0, 0]);
  assert.equal(
    (status.body as { value: { initialized: boolean } }).value.initialized,
    true,
  );
  const back: Tables = Object.fromEntries(TABLES.map((table) => [table, []]));
  let cursor: string | null = "start";
  while (cursor !== null) {
    const response = await request(
      target,
      `dump?cursor=${encodeURIComponent(cursor)}`,
    );
    assert.deepEqual([response.sql, response.kv], [0, 0]);
    const page = (
      response.body as { value: { tables: Tables; next: string | null } }
    ).value;
    for (const table of TABLES) back[table]!.push(...page.tables[table]!);
    cursor = page.next;
  }
  const observed = stopObservation(window);
  observed.add(back);
  const at = observed.floorClock();
  const actor = { kind: "agent", id: "cloud-restore" };
  const value = { number: expected.lastSequence, prefix: "issue:work-" };
  const record = {
    namespace: "forge/work",
    key: "allocation:issue:work-",
    revision: 1,
    value,
    updatedAt: at,
    updatedBy: actor,
  };
  const floorRows: readonly [Tables[string][number], Tables[string][number]] = [
    {
      namespace: record.namespace,
      key: record.key,
      revision: 1,
      body: canonicalJson(record),
    },
    {
      sequence: expected.lastSequence + 1,
      namespace: record.namespace,
      key: record.key,
      body: canonicalJson({
        type: "forge/work:record.updated@1",
        namespace: record.namespace,
        key: record.key,
        revision: 1,
        at,
        actor,
        data: value,
      }),
    },
  ];
  const proof = tally(
    expected,
    stopPlan(original, observed.delta(), floorRows, 1),
  );
  for (const table of TABLES)
    for (const row of back[table]!) fold(proof, table, row);
  assert.deepEqual(problems(proof, expected), []);
  const floor = back.state_records!.find(
    (row) => row.key === "allocation:issue:work-",
  );
  assert.equal(
    (JSON.parse(String(floor?.body)) as { value: { number: number } }).value
      .number,
    expected.lastSequence,
  );
}

for (const records of sizes) {
  const fixture = source(records);
  for (const mode of ["whole", "paged"]) {
    const target = `${run}-${mode}-${records}`;
    const parts = mode === "whole" ? [fixture.doc] : fixture.pages;
    const statements = new Map<string, StatementProfile>();
    let sql = 0,
      kv = 0,
      window: readonly [number, number] = [0, 0];
    for (const part of parts) {
      const response = await request(target, "restore", part, true);
      const body = response.body as {
        response: { ok: boolean; value: { done?: boolean } };
        profile: StatementProfile[];
      };
      if (body.response.value.done !== false)
        window = stopWindowOf(body.response.value);
      assert.equal(body.response.ok, true);
      assert.equal(
        body.profile.reduce((n, entry) => n + entry.rows, 0),
        response.sql,
      );
      sql += response.sql;
      kv += response.kv;
      for (const entry of body.profile) {
        const key = `${entry.kind}\n${entry.statement}`;
        const prior = statements.get(key) ?? {
          ...entry,
          calls: 0,
          rows: 0,
          reads: 0,
        };
        prior.calls += entry.calls;
        prior.rows += entry.rows;
        prior.reads += entry.reads;
        statements.set(key, prior);
      }
    }
    await verify(target, fixture.doc.tables, fixture.expected, window);
    for (const table of ["state_records", "state_events"])
      assert.equal(
        [...statements.values()]
          .filter((entry) => entry.kind === `${table} inserts`)
          .reduce((n, entry) => n + entry.calls, 0),
        records,
      );
    const groups: Record<string, number> = {};
    for (const entry of statements.values())
      groups[entry.kind] = (groups[entry.kind] ?? 0) + entry.rows;
    const result = {
      records,
      mode,
      pages: parts.length,
      bytes: fixture.bytes,
      sql,
      kv,
      total: sql + kv,
      perRecord: (sql + kv) / records,
      groups,
      statements: [...statements.values()].sort((a, b) => b.rows - a.rows),
    };
    results.push(result);
    console.log(
      `RESTORE_COST ${JSON.stringify({ ...result, statements: undefined })}`,
    );
    console.log(
      `PASS restore cost: ${mode} ${records} records, complete digest and floor`,
    );
  }
}

function fit(points: Measurement[], column: "sql" | "total") {
  const x = points.reduce((n, p) => n + p.records, 0) / points.length;
  const y = points.reduce((n, p) => n + p[column], 0) / points.length;
  const perRecord =
    points.reduce((n, p) => n + (p.records - x) * (p[column] - y), 0) /
    points.reduce((n, p) => n + (p.records - x) ** 2, 0);
  const fixed = y - perRecord * x;
  return {
    fixed,
    perRecord,
    maxResidual: Math.max(
      ...points.map((p) => Math.abs(p[column] - fixed - perRecord * p.records)),
    ),
  };
}
const fits = Object.fromEntries(
  ["whole", "paged"].map((mode) => {
    const points = results.filter((p) => p.mode === mode);
    return [mode, { sql: fit(points, "sql"), total: fit(points, "total") }];
  }),
);
console.log(`RESTORE_COST_FIT ${JSON.stringify(fits)}`);
writeFileSync(
  join(process.env.RUNNER_TEMP!, "restore-cost.json"),
  JSON.stringify({ results, fits }, null, 2),
);
