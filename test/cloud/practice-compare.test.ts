import { expect, setDefaultTimeout, test } from "bun:test";
import * as importer from "../../tools/import-current.ts";
import { currentState, pagesOf } from "../../tools/import-current-state.ts";
import { TABLES, COLUMNS, type Table } from "../../cloud/conformance/digest.ts";
import type { Tables } from "../../cloud/conformance/max-source.ts";
import { LaneControlStore } from "../../cloud/src/lane-control-store.ts";
import { limitsFrom } from "../../cloud/src/dump.ts";
import * as f from "./import-current-state.fixture.ts";

setDefaultTimeout(30_000);
type Comparison = {
  tables: Record<
    Table,
    { match: boolean | null; actual: { rows: number; digest: string } | null }
  >;
};
type Refusal = {
  code: string;
  message: string;
  observed: Comparison & {
    failure: { table: Table | null; key: string[] | null; reason: string };
  };
};
const api = importer as unknown as {
  verifyPracticeReadback(
    source: Tables,
    actual: Tables,
    window: readonly [number, number],
  ): Comparison;
  practiceComparisonRefusal(error: unknown): Refusal | undefined;
};
function fixture(incident = false) {
  const source = f.source(incident ? 7138 : 6, false, false, (db, owner) => {
    if (!incident) return;
    for (let n = 1; n <= 154; n++)
      owner.put(
        f.ns,
        `issue:work-${n}`,
        { ...f.issueValue(`work-${n}`), status: "closed" },
        f.actor,
        { expectRevision: 1 },
      );
    for (let n = 2; n < 1120; n++) {
      const key = `comment:work-${n}:1`;
      owner.put(f.ns, key, { id: `work-${n}`, body: "historical" }, f.actor, {
        expectRevision: 0,
      });
      owner.delete(f.ns, key, f.actor, { expectRevision: 1 });
    }
    for (let n = 1; n <= 1763; n++)
      owner.put(
        "forge/memory",
        `note/${n}`,
        { text: "retained inventory" },
        f.actor,
        { expectRevision: 0 },
      );
    for (const family of [
      "autopilot-clock",
      "autopilot-ask",
      "autopilot-event",
    ])
      owner.put(
        f.ns,
        `${family}:work-1${family === "autopilot-event" ? ":1" : ""}`,
        {},
        f.actor,
        { expectRevision: 0 },
      );
    while (Number(db.get("SELECT COUNT(*) AS n FROM state_events")!.n) < 15577)
      owner.put(f.ns, "issue:work-200", f.issueValue("work-200"), f.actor, {
        expectRevision: owner.get(f.ns, "issue:work-200")!.revision,
      });
  });
  const db = f.database();
  const owner = f.owner(db);
  owner.initialize();
  const projected = currentState(
    source.db,
    db,
    source.manifest,
    limitsFrom({}),
  );
  const take = () => {
    const tables = Object.fromEntries(
      TABLES.map((table) => [table, []]),
    ) as Tables;
    for (const page of pagesOf(db, limitsFrom({})))
      for (const table of TABLES) tables[table]!.push(...page.tables[table]!);
    return tables;
  };
  const before = take();
  expect(
    new LaneControlStore(owner, "fixture").stop(
      { all: true },
      "cloud-restore",
      "cloud-restore",
      new Date(f.at).toISOString(),
    ).ok,
  ).toBe(true);
  return {
    source,
    before,
    actual: take(),
    projected,
    window: [f.at - 1, f.at + 1] as const,
  };
}
function refusal(
  source: Tables,
  actual: Tables,
  window: readonly [number, number],
) {
  let caught: unknown;
  try {
    api.verifyPracticeReadback(source, actual, window);
  } catch (error) {
    caught = error;
  }
  const result = api.practiceComparisonRefusal(caught);
  expect(result).toBeDefined();
  expect(result!.code).toBe("PRACTICE_VERIFICATION_FAILED");
  expect(Object.keys(result!.observed.tables).sort()).toEqual(
    [...TABLES].sort(),
  );
  return result!;
}
test("incident counts, floors, inventory and 154 repairs compare with the two-row restore stop", () => {
  const f = fixture(true);
  expect(f.source.manifest.records).toBe(8904);
  expect(f.source.manifest.eventHighWaterMark).toBe(15577);
  expect([f.projected.records, f.projected.floors, f.projected.events]).toEqual(
    [7138, 1118, 8256],
  );
  expect(f.projected.repaired).toEqual({
    records: 154,
    historicalUpdates: 154,
  });
  expect(
    f.projected.leftBehind.report.records.reduce((n, row) => n + row.count, 0),
  ).toBe(1766);
  const result = api.verifyPracticeReadback(f.before, f.actual, f.window);
  expect(result.tables.state_records.actual!.rows).toBe(8258);
  expect(result.tables.state_events.actual!.rows).toBe(8258);
  expect(
    Object.values(result.tables).every((table) => table.match === true),
  ).toBe(true);
});
test("a stop-clock refusal retains its check, table, key and all per-table actual digests", () => {
  const sample = fixture();
  const result = refusal(sample.before, sample.actual, [
    f.at + 1000,
    f.at + 2000,
  ]);
  expect(result.observed.failure).toEqual({
    table: "state_records",
    key: ["forge/work", "lane-control:global"],
    reason: "stop request window",
  });
  expect(result.message).toContain("stop request window");
  expect(result.observed).toHaveProperty("stopOffsetMs", -1000);
  expect(result.observed.tables.state_records.match).toBeNull();
  for (const table of TABLES)
    expect(result.observed.tables[table].actual!.digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
  expect(result.observed.tables.state_leases.match).toBe(true);
});
test.each(["content", "missing", "unexpected"] as const)(
  "the first %s mismatch names its table and key without record values",
  (kind) => {
    const f = fixture(),
      rows = f.actual.state_records!;
    const index = rows.findIndex((row) => row.key === "issue:work-1");
    if (kind === "content") {
      const body = JSON.parse(String(rows[index]!.body)) as {
        value: { title: string };
      };
      body.value.title = "fixture-private-value-must-not-leak";
      rows[index]!.body = JSON.stringify(body);
    } else if (kind === "missing") rows.splice(index, 1);
    else rows.splice(index, 0, { ...rows[index]!, key: "issue:work-0" });
    const result = refusal(f.before, f.actual, f.window);
    expect(result.observed.failure.table).toBe("state_records");
    expect(result.observed.failure.key).toEqual([
      "forge/work",
      kind === "unexpected" ? "issue:work-0" : "issue:work-1",
    ]);
    expect(result.observed.tables.state_records.match).toBe(false);
    expect(JSON.stringify(result)).not.toContain(
      "fixture-private-value-must-not-leak",
    );
  },
);
test("a stop audit refusal identifies the first offending event sequence", () => {
  const f = fixture(),
    last = f.actual.state_events!.at(-1)!;
  last.key = "issue:work-1";
  const result = refusal(f.before, f.actual, f.window);
  expect(result.observed.failure).toEqual({
    table: "state_events",
    key: [String(last.sequence)],
    reason: "stop audit suffix",
  });
});
test.each(["all", "audit"] as const)(
  "missing %s events identify the first expected event, never a surviving neighbor",
  (kind) => {
    const sample = fixture();
    const events = sample.actual.state_events!;
    const expected = String(
      events[kind === "all" ? 0 : events.length - 1]!.sequence,
    );
    if (kind === "all") events.splice(0);
    else events.pop();
    const result = refusal(sample.before, sample.actual, sample.window);
    expect(result.observed.failure).toEqual({
      table: "state_events",
      key: [expected],
      reason: "missing row",
    });
    expect(result.observed.tables.state_events.actual!.rows).toBe(
      events.length,
    );
  },
);
test("a divergent global update is named before a missing audit", () => {
  const sample = fixture();
  sample.actual.state_events!.pop();
  const update = sample.actual.state_events!.at(-1)!;
  update.key = "issue:work-1";
  const result = refusal(sample.before, sample.actual, sample.window);
  expect(result.observed.failure).toEqual({
    table: "state_events",
    key: [String(update.sequence)],
    reason: "stop global event key",
  });
});
test("an extra event after the audit is compared as an extra event", () => {
  const sample = fixture();
  const audit = sample.actual.state_events!.at(-1)!;
  const sequence = Number(audit.sequence) + 1;
  sample.actual.state_events!.push({ ...audit, sequence, key: "issue:work-1" });
  const result = refusal(sample.before, sample.actual, sample.window);
  expect(result.observed.failure).toEqual({
    table: "state_events",
    key: [String(sequence)],
    reason: "unexpected row",
  });
});
test("foreign exceptions are refused without their message", () => {
  const result = api.practiceComparisonRefusal(
    new Error("fixture-private-value-must-not-leak"),
  )!;
  expect(result.observed.failure).toEqual({
    table: null,
    key: null,
    reason: "unexpected:Error",
  });
  expect(JSON.stringify(result)).not.toContain(
    "fixture-private-value-must-not-leak",
  );
});

test("a malformed stop timestamp keeps a named check and every table digest", () => {
  const f = fixture();
  const global = f.actual.state_records!.find(
    (row) => row.key === "lane-control:global",
  )!;
  const body = JSON.parse(String(global.body)) as { updatedAt: unknown };
  body.updatedAt = { toString: null };
  global.body = JSON.stringify(body);
  const result = refusal(f.before, f.actual, f.window);
  expect(result.observed.failure.reason).toBe("stop ISO clock");
  for (const table of TABLES)
    expect(result.observed.tables[table].actual!.digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
});

test.each(["missing", "null row"] as const)(
  "a %s table is refused as that table with the others digested",
  (kind) => {
    const f = fixture();
    if (kind === "missing") delete f.actual.state_leases;
    else f.actual.state_leases!.push(null as never);
    const result = refusal(f.before, f.actual, f.window);
    expect(result.observed.failure).toEqual({
      table: "state_leases",
      key: [],
      reason: "table shape",
    });
    expect(result.observed.tables.state_leases).toMatchObject({
      actual: null,
      match: false,
    });
    for (const table of TABLES.filter((name) => name !== "state_leases"))
      expect(result.observed.tables[table].actual!.digest).toMatch(
        /^[a-f0-9]{64}$/,
      );
  },
);

test("a generic exception inside a check becomes an unexpected refusal", () => {
  const f = fixture();
  Object.defineProperty(f.before.state_events!, "at", {
    value: () => {
      throw new RangeError("fixture-private-value-must-not-leak");
    },
  });
  const result = refusal(f.before, f.actual, f.window);
  expect(result.observed.failure).toEqual({
    table: null,
    key: null,
    reason: "unexpected:RangeError",
  });
  expect(JSON.stringify(result)).not.toContain(
    "fixture-private-value-must-not-leak",
  );
});

test.each(["incarnation", "audit", "JSON"] as const)(
  "stop %s failures retain their named check without values",
  (kind) => {
    const f = fixture();
    const global = f.actual.state_records!.find(
      (row) => row.key === "lane-control:global",
    )!;
    if (kind === "JSON") global.body = "fixture-private-value-must-not-leak";
    else if (kind === "audit")
      f.actual.state_events!.at(-1)!.key = "lane-control:audit:not-a-uuid";
    else {
      const body = JSON.parse(String(global.body)) as {
        value: { incarnation: string };
      };
      body.value.incarnation = "fixture-private-value-must-not-leak";
      global.body = JSON.stringify(body);
    }
    const result = refusal(f.before, f.actual, f.window);
    expect(result.observed.failure.reason).toBe(
      kind === "JSON" ? "stop metadata JSON" : `stop ${kind} UUID`,
    );
    expect(JSON.stringify(result)).not.toContain(
      "fixture-private-value-must-not-leak",
    );
  },
);

test.each(TABLES)(
  "a mismatch in %s retains its first key and the other table results",
  (table) => {
    const f = fixture();
    if (table === "state_records") {
      f.actual[table]!.find((row) => row.key === "issue:work-1")!.body += " ";
    } else if (table === "state_events") f.actual[table]![0]!.body += " ";
    else
      f.actual[table]!.push(
        Object.fromEntries<string | number>(
          COLUMNS[table].map((column) => [
            column,
            column === "namespace"
              ? "forge/work"
              : column === "subject"
                ? "subject"
                : column === "request_id"
                  ? "request-1"
                  : column === "generation"
                    ? 1
                    : "{}",
          ]),
        ),
      );
    const result = refusal(f.before, f.actual, f.window);
    expect(result.observed.failure.table).toBe(table);
    expect(result.observed.failure.key).toEqual(
      table === "state_records"
        ? ["forge/work", "issue:work-1"]
        : table === "state_events"
          ? ["1"]
          : table === "state_leases"
            ? ["forge/work", "subject"]
            : table === "state_requests"
              ? ["forge/work", "request-1"]
              : ["request-1"],
    );
    expect(result.observed.tables[table].match).toBe(false);
  },
);
