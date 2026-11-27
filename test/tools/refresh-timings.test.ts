import { expect, setDefaultTimeout, test } from "bun:test";
import { type jobRecord } from "../../tools/ci/ci-record.ts";
import { refreshTimings } from "../../tools/ci/refresh-timings.ts";

setDefaultTimeout(30_000);

type Entry = ReturnType<typeof jobRecord>;
const entry = (
  files: Record<string, number | null>,
  shard = "1/3",
): Entry => ({
  run_id: "1",
  run_attempt: 1,
  head_sha: "abc",
  os: "Windows",
  node: "24",
  shard,
  wallMs: 1,
  files: Object.fromEntries(
    Object.entries(files).map(([file, durationMs]) => [
      file,
      { durationMs, status: durationMs === null ? "skip" : "pass" },
    ]),
  ),
});

test("odd and even medians round to whole milliseconds", () => {
  expect(
    refreshTimings(
      [
        entry({ "a.test.ts": 3 }),
        entry({ "a.test.ts": 1 }),
        entry({ "a.test.ts": 2 }),
      ],
      ["a.test.ts"],
      {},
    ),
  ).toEqual({ "a.test.ts": 2 });
  expect(
    refreshTimings(
      [
        entry({ "a.test.ts": 1 }),
        entry({ "a.test.ts": 2 }),
        entry({ "a.test.ts": 3 }),
        entry({ "a.test.ts": 4 }),
      ],
      ["a.test.ts"],
      {},
    ),
  ).toEqual({ "a.test.ts": 3 });
  expect(
    refreshTimings(
      [entry({ "a.test.ts": 1 }), entry({ "a.test.ts": 2 })],
      ["a.test.ts"],
      {},
    ),
  ).toEqual({ "a.test.ts": 2 });
});

test("unselected files and non-shard records are dropped", () => {
  expect(
    refreshTimings(
      [
        entry({ "a.test.ts": 10, "other.test.ts": 999 }),
        entry({ "a.test.ts": 20 }),
        entry({ "a.test.ts": 30 }, "comment-guard"),
        { ...entry({ "a.test.ts": 40 }), os: "ubuntu-latest" },
        { ...entry({ "a.test.ts": 50 }), node: "26" },
        entry({ "a.test.ts": null }),
      ],
      ["a.test.ts"],
      {},
    ),
  ).toEqual({ "a.test.ts": 15 });
});

test("a selected file with no records keeps its old value, without one it is omitted", () => {
  const out = refreshTimings([entry({ "a.test.ts": 5 })], ["a.test.ts", "b.test.ts", "c.test.ts"], {
    "b.test.ts": 42,
  });
  expect(out).toEqual({ "a.test.ts": 5, "b.test.ts": 42 });
  expect(Object.keys(out)).toEqual(["a.test.ts", "b.test.ts"]);
});

test("output keys are sorted", () => {
  const out = refreshTimings(
    [entry({ "b.test.ts": 2, "a.test.ts": 1, "c.test.ts": 3 })],
    ["c.test.ts", "b.test.ts", "a.test.ts"],
    {},
  );
  expect(out).toEqual({ "a.test.ts": 1, "b.test.ts": 2, "c.test.ts": 3 });
  expect(Object.keys(out)).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
});
