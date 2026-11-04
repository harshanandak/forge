import { expect, setDefaultTimeout, test } from "bun:test";
import { traceWindow } from "../../tools/ci/read-trace.ts";

setDefaultTimeout(1000);
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
