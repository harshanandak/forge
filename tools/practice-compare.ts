import { ForgeFailure } from "../src/contract/failure.ts";
import {
  TABLES,
  COLUMNS,
  KEYS,
  tally,
  fold,
  digests,
  type Table,
} from "../cloud/conformance/digest.ts";
import {
  stopPlan,
  stopOverlay,
  type StopDelta,
} from "../cloud/conformance/restored.ts";
import {
  ComparisonCheckFailure,
  comparisonCheck,
  comparisonRecord,
  type ComparisonProblem as Failure,
} from "../cloud/conformance/comparison-check.ts";
import type { Tables } from "../cloud/conformance/max-source.ts";

type Row = Tables[string][number];
type Digest = { rows: number; digest: string };
export interface PracticeComparison {
  ok: boolean;
  phase: "stop-metadata" | "rows" | "complete";
  restoreWindow: readonly [number, number];
  stopOffsetMs?: number | null;
  tables: Record<
    Table,
    { expected: Digest | null; actual: Digest; match: boolean | null }
  >;
  failure?: Failure;
}
class ComparisonFailure extends ForgeFailure {
  constructor(report: PracticeComparison) {
    const { table, key, reason } = report.failure!;
    super({
      code: "PRACTICE_VERIFICATION_FAILED",
      message: `${reason}: ${table} ${JSON.stringify(key)}`,
      retry: "never",
      observed: report,
    });
  }
}
export function practiceComparisonRefusal(error: unknown) {
  return error instanceof ComparisonFailure ? error.error : undefined;
}
function hash(tables: Tables) {
  const sum = tally();
  for (const table of TABLES)
    for (const row of tables[table]!) fold(sum, table, row);
  return digests(sum);
}
const keyOf = (table: Table, row: Row) =>
  KEYS[table].map((column) => String(row[column]));
const encoded = (table: Table, row: Row) =>
  JSON.stringify(COLUMNS[table].map((column) => row[column]));
function firstMismatch(
  table: Table,
  expected: Row[],
  actual: Row[],
): Failure | undefined {
  for (
    let index = 0;
    index < Math.max(expected.length, actual.length);
    index++
  ) {
    const left = expected[index],
      right = actual[index];
    if (left && right && encoded(table, left) === encoded(table, right))
      continue;
    if (!left)
      return { table, key: keyOf(table, right!), reason: "unexpected row" };
    if (!right)
      return { table, key: keyOf(table, left), reason: "missing row" };
    for (const column of KEYS[table]) {
      const a = left[column],
        b = right[column];
      const order =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
      if (order)
        return {
          table,
          key: keyOf(table, order < 0 ? left : right),
          reason: order < 0 ? "missing row" : "unexpected row",
        };
    }
    return { table, key: keyOf(table, left), reason: "different row content" };
  }
}
function observeStop(
  source: Tables,
  actual: Tables,
  window: readonly [number, number],
): StopDelta {
  const globalKey = ["forge/work", "lane-control:global"];
  const global = actual.state_records!.find(
    (row) => row.namespace === globalKey[0] && row.key === globalKey[1],
  );
  comparisonCheck(global, "state_records", globalKey, "missing row");
  const record = comparisonRecord(global.body, "state_records", globalKey);
  const events = source.state_events!;
  const mismatch = firstMismatch(
    "state_events",
    events,
    actual.state_events!.slice(0, events.length),
  );
  if (mismatch) throw new ComparisonCheckFailure(mismatch);
  const next = Number(events.at(-1)?.sequence ?? 0) + 1;
  const event = (index: number, sequence: number) => {
    const row = actual.state_events![index];
    const key = [String(sequence)];
    comparisonCheck(row, "state_events", key, "missing row");
    comparisonCheck(
      row.sequence === sequence,
      "state_events",
      typeof row.sequence === "number" && row.sequence < sequence
        ? keyOf("state_events", row)
        : key,
      typeof row.sequence === "number" && row.sequence < sequence
        ? "unexpected row"
        : "missing row",
    );
    return row;
  };
  const update = event(events.length, next);
  comparisonCheck(
    update.key === "lane-control:global",
    "state_events",
    [String(next)],
    "stop global event key",
  );
  const audit = event(events.length + 1, next + 1);
  comparisonCheck(
    typeof audit.key === "string" &&
      audit.key.startsWith("lane-control:audit:"),
    "state_events",
    [String(next + 1)],
    "stop audit suffix",
  );
  return {
    at: record.updatedAt as string,
    incarnation: record.value.incarnation as string,
    auditId: audit.key.slice("lane-control:audit:".length),
    window,
  };
}
export function verifyPracticeReadback(
  source: Tables,
  actual: Tables,
  window: readonly [number, number],
): PracticeComparison {
  const received = hash(actual),
    baseline = hash(source);
  const report: PracticeComparison = {
    ok: false,
    phase: "stop-metadata",
    restoreWindow: window,
    tables: Object.fromEntries(
      TABLES.map((table) => {
        const changed = table === "state_records" || table === "state_events";
        return [
          table,
          {
            expected: changed ? null : baseline[table],
            actual: received[table],
            match: changed
              ? null
              : received[table].digest === baseline[table].digest,
          },
        ];
      }),
    ) as PracticeComparison["tables"],
  };
  let expected: Tables;
  try {
    const delta = observeStop(source, actual, window);
    const stopTime = Date.parse(delta.at);
    report.stopOffsetMs = Number.isFinite(stopTime)
      ? stopTime - window[0]
      : null;
    expected = stopOverlay(source, stopPlan(source, delta));
  } catch (error) {
    if (!(error instanceof ComparisonCheckFailure)) throw error;
    report.failure = error.problem;
    throw new ComparisonFailure(report);
  }
  report.phase = "rows";
  const wanted = hash(expected);
  for (const table of TABLES) {
    const match =
      received[table].rows === wanted[table].rows &&
      received[table].digest === wanted[table].digest;
    report.tables[table] = {
      expected: wanted[table],
      actual: received[table],
      match,
    };
    if (!match && !report.failure) {
      const failure = firstMismatch(table, expected[table]!, actual[table]!);
      if (!failure)
        throw new ForgeFailure({
          code: "INTERNAL",
          message: "Digest mismatch without a divergent row",
          retry: "never",
          observed: { table },
        });
      report.failure = failure;
    }
  }
  if (report.failure) throw new ComparisonFailure(report);
  report.ok = true;
  report.phase = "complete";
  return report;
}
