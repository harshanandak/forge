import { expect, setDefaultTimeout, test } from "bun:test";
import {
  traceWindow,
  parseCounters,
  topIo,
} from "../../tools/ci/read-trace.ts";

setDefaultTimeout(1000);
test("reads disk/process counters and ranks I/O only near the worst queue", async () => {
  const fixture = await Bun.file(
    new URL("./fixtures/windows-io.jsonl", import.meta.url),
  ).text();
  const lines = traceWindow(
    fixture,
    "2026-11-04T03:00:00Z",
    "2026-11-04T03:00:20Z",
  );
  const { performanceCounters: counters } = JSON.parse(lines[0]!) as {
    performanceCounters: Record<string, number>;
  };
  expect(
    parseCounters(Object.keys(counters), Object.values(counters).map(String)),
  ).toEqual(counters);
  expect(
    parseCounters(["\\\\host\\Process(bun)\\IO Data Bytes/sec"], ["-1"]),
  ).toEqual({ "\\\\host\\Process(bun)\\IO Data Bytes/sec": null });
  expect(topIo(lines)).toEqual([
    ["MsMpEng", 900],
    ["bun#1", 200],
  ]);
  expect(
    topIo([JSON.stringify({ timestamp: "2026-11-04T03:00:00Z" })]),
  ).toEqual([]);
});
const start = "2026-11-04T03:00:01Z";
const end = "2026-11-04T03:00:02Z";
const rows = [0, 1, 2, 3].map((second) =>
  JSON.stringify({ timestamp: `2026-11-04T03:00:0${second}Z`, gapMs: 1000 }),
);

test("filters inclusive UTC windows and tolerates a partial tail", () => {
  const trace = [...rows, '{"timestamp":', ""].join("\r\n");
  expect(traceWindow(trace, start, end)).toEqual(rows.slice(1, 3));
  expect(traceWindow(rows.join("\n"), start, start)).toEqual(rows.slice(1, 2));
  expect(traceWindow("", start, end)).toEqual([]);
  expect(() => traceWindow(trace, end, start)).toThrow("UTC window");
  expect(() => traceWindow(trace, "invalidZ", end)).toThrow("UTC window");
  expect(() => traceWindow(trace, start.slice(0, -1), end)).toThrow(
    "UTC window",
  );
});
