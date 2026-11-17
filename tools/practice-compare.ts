import { ForgeFailure } from "../src/contract/failure.ts";
import { AssertionError } from "node:assert";
import {
  TABLES,
  COLUMNS,
  KEYS,
  tally,
  fold,
  digests,
  type Table,
} from "../cloud/conformance/digest.ts";
import { stopPlan, stopOverlay } from "../cloud/conformance/restored.ts";
import { stopObservation } from "../cloud/conformance/stop-live.ts";
import type { Tables } from "../cloud/conformance/max-source.ts";

type Row = Tables[string][number];
type Digest = { rows: number; digest: string };
interface Failure {
  table: Table;
  key: string[];
  reason: string;
}
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
function firstMismatch(table: Table, expected: Row[], actual: Row[]): Failure {
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
  throw new Error("Digest mismatch without a divergent row");
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
    const observation = stopObservation(window);
    observation.add(actual);
    const delta = observation.delta();
    const stopTime = Date.parse(delta.at);
    report.stopOffsetMs = Number.isFinite(stopTime)
      ? stopTime - window[0]
      : null;
    expected = stopOverlay(source, stopPlan(source, delta));
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : "";
    const reason =
      error instanceof AssertionError && !error.generatedMessage
        ? message
        : error instanceof SyntaxError
          ? "stop metadata JSON"
          : error instanceof RangeError
            ? "stop ISO clock"
            : "stop expectation construction";
    const table: Table = reason.includes("audit")
      ? "state_events"
      : "state_records";
    const key =
      table === "state_events"
        ? [
            String(
              actual.state_events!.at(-1)?.sequence ?? "missing stop audit",
            ),
          ]
        : ["forge/work", "lane-control:global"];
    report.failure = { table, key, reason };
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
    if (!match && !report.failure)
      report.failure = firstMismatch(table, expected[table]!, actual[table]!);
  }
  if (report.failure) throw new ComparisonFailure(report);
  report.ok = true;
  report.phase = "complete";
  return report;
}
