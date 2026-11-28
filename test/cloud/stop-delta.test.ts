import assert from "node:assert/strict";
import { mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import {
  SHAPE,
  scratchStorage,
  tablesOf,
  type Tables,
} from "../../cloud/conformance/max-source.ts";
import {
  stopPlan,
  stopOverlay,
  replayImage,
} from "../../cloud/conformance/restored.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { durableStore } from "../../cloud/src/store.ts";
import { domain } from "../../cloud/src/project.ts";
import { LaneControlStore } from "../../cloud/src/lane-control-store.ts";
import {
  tally,
  fold,
  digests,
  problems,
  type Table,
  type Expected,
  FLOOR,
} from "../../cloud/conformance/digest.ts";
import {
  expectsStop,
  liveStops,
  stopObservation,
  stopWindowOf,
} from "../../cloud/conformance/stop-live.ts";
import type { StopDelta } from "../../cloud/conformance/restored.ts";
import { digester } from "../../cloud/conformance/budget.ts";

const nativeStopLive = {
  expectsStop,
  liveStops,
  stopObservation,
  stopWindowOf,
};
const restoreObservers: ReturnType<typeof liveStops>[] = [];
await mock.module(
  resolve(import.meta.dirname, "../../cloud/conformance/stop-live.ts"),
  () => ({
    ...nativeStopLive,
    liveStops: () => {
      const live = nativeStopLive.liveStops();
      restoreObservers.push(live);
      return live;
    },
  }),
);

const at = "2027-01-15T08:00:00.000Z";
const actor = { kind: "agent", id: "cloud-restore" } as const;
const namespace = "forge/work";
const incarnation = "11111111-1111-4111-8111-111111111111";
const deltas = [1, 2].map((n) => ({
  at,
  incarnation,
  auditId: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
  window: [Date.parse(at) - 1, Date.parse(at) + 1] as const,
}));
const record = (key: string, value: unknown, revision = 1, updatedAt = at) => ({
  namespace,
  key,
  revision,
  body: canonicalJson({
    namespace,
    key,
    revision,
    value,
    updatedAt,
    updatedBy: actor,
  }),
});
function fixture(prior: boolean): Tables {
  const tables: Tables = Object.fromEntries(
    Object.keys(SHAPE).map((t) => [t, []]),
  );
  tables.state_records = [
    record("issue:work-1", { body: 'source Ã©â‚¬\\"' }),
    record("lane-control:work-1", { epoch: 2, stoppedAt: at }),
  ];
  if (prior)
    tables.state_records.push(
      record(
        "lane-control:global",
        {
          version: 1,
          incarnation,
          epoch: 7,
          resumeAllEpoch: 5,
          stopAll: at,
        },
        3,
      ),
    );
  tables.state_records.sort((a, b) =>
    String(a.key).localeCompare(String(b.key)),
  );
  tables.state_events = [
    { sequence: 9, namespace, key: "issue:work-1", body: "source" },
  ];
  return tables;
}
// Independent synthetic producer: no product stop implementation or checker renderer is called.
function inject(
  source: Tables,
  n: number,
  prior: boolean,
  stopAt = at,
): Tables {
  const epoch = (prior ? 7 : 0) + n,
    revision = (prior ? 3 : 0) + n;
  const global = record(
    "lane-control:global",
    {
      version: 1,
      incarnation,
      epoch,
      resumeAllEpoch: prior ? 5 : 0,
      stopAll: stopAt,
    },
    revision,
    stopAt,
  );
  const audit = record(
    `lane-control:audit:${deltas[n - 1]!.auditId}`,
    {
      version: 1,
      action: "stop",
      scope: { all: true },
      device: "cloud-restore",
      session: "cloud-restore",
      at: stopAt,
      incarnation,
      epoch,
    },
    1,
    stopAt,
  );
  const events = [global, audit].map((row, i) => ({
    sequence: Number(source.state_events!.at(-1)!.sequence) + i + 1,
    namespace,
    key: row.key,
    body: canonicalJson({
      type: "forge/work:record.updated@1",
      namespace,
      key: row.key,
      revision: row.revision,
      at: stopAt,
      actor,
      data: (JSON.parse(row.body) as { value: unknown }).value,
    }),
  }));
  return {
    ...source,
    state_records: [
      ...source.state_records!.filter(
        (row) => row.key !== "lane-control:global",
      ),
      global,
      audit,
    ].sort((a, b) => String(a.key).localeCompare(String(b.key))),
    state_events: [...source.state_events!, ...events],
  };
}
const page = (tables: Tables) => ({
  format: "forge-cloud-dump-page/2",
  page: 0,
  last: true,
  next: null,
  tables,
});
type Comparison = {
  fixture: Tables;
  seed: StopDelta | (() => StopDelta) | false;
  target: StopDelta | (() => StopDelta);
};
// Main ignores the extra parameter: red is a comparison assertion, not an import failure.
const compare = async (
  source: string,
  target: string,
  label: string,
  budget: number,
  each: undefined,
  expected: undefined,
  comparison: Comparison,
) => {
  const { roundTrip } = await import("../../cloud/conformance/conformance.ts");
  return roundTrip(source, target, label, budget, each, expected, comparison);
};

test("stop delta: none preserves references and sparse merge preserves SQL order", () => {
  const source = fixture(false);
  const bmp = record("\ue000", {}),
    astral = record("\u{10000}", {});
  source.state_records!.push(bmp, astral);
  assert.equal(stopPlan(source), undefined);
  assert.equal(stopOverlay(source), source);
  const after = stopOverlay(source, stopPlan(source, deltas[0]));
  assert.equal(after.state_records!.at(-2), bmp);
  assert.equal(after.state_records!.at(-1), astral);
  assert.equal(after.state_events![0], source.state_events![0]);
}, 1000);

test("stop delta: a deleted global keeps historical revisions", () => {
  const source = fixture(false);
  source.state_events!.push({
    sequence: 10,
    namespace,
    key: "lane-control:global",
    body: canonicalJson({ type: "forge/work:record.deleted@1", revision: 4 }),
  });
  source.state_events!.push({
    sequence: 11,
    namespace,
    key: "lane-control:global",
    body: canonicalJson({ type: "forge/work:lease.acquired@1", revision: 99 }),
  });
  const plan = stopPlan(source, deltas[0])!;
  assert.equal(plan.records[0]!.revision, 5);
  assert.deepEqual(
    plan.events.map((row) => row.sequence),
    [12, 13],
  );
}, 1000);
const cases = [
  "correct",
  "live callbacks",
  "observed source",
  "duplicate event",
  "swapped events",
  "missing event",
  "wrong epoch",
  "missing audit",
  "imported lane",
  "dropped row",
  "changed byte",
  "source drift",
  "bad seed",
] as const;
test.each(cases)(
  "stop delta: %s",
  async (kind) => {
    for (const prior of [false, true]) {
      const original = fixture(prior),
        source = inject(original, 1, prior),
        target = inject(source, 2, prior);
      const events = target.state_events!,
        records = target.state_records!;
      if (kind === "duplicate event") events.push(events.at(-1)!);
      if (kind === "swapped events")
        [events[events.length - 2], events[events.length - 1]] = [
          events.at(-1)!,
          events.at(-2)!,
        ];
      if (kind === "missing event") events.pop();
      if (kind === "wrong epoch") {
        const row = records.find((row) => row.key === "lane-control:global")!;
        row.body = String(row.body).replace(
          `"epoch":${(prior ? 7 : 0) + 2}`,
          '"epoch":0',
        );
      }
      if (kind === "missing audit")
        target.state_records = records.filter(
          (row) => row.key !== `lane-control:audit:${deltas[1]!.auditId}`,
        );
      if (
        kind === "imported lane" ||
        kind === "changed byte" ||
        kind === "source drift"
      ) {
        const key =
          kind === "imported lane" ? "lane-control:work-1" : "issue:work-1";
        target.state_records = records.map((row) =>
          row.key === key
            ? {
                ...row,
                body: String(row.body).replace(
                  kind === "imported lane" ? '"epoch":2' : "source",
                  kind === "imported lane" ? '"epoch":3' : "sourcf",
                ),
              }
            : row,
        );
      }
      if (kind === "dropped row")
        target.state_records = records.filter(
          (row) => row.key !== "issue:work-1",
        );
      if (kind === "bad seed")
        source.state_events = source.state_events!.map((row) =>
          row.sequence === 9 ? { ...row, body: "sourcf" } : row,
        );
      let restored = false;
      let sourceExports = 0,
        seedRead = false;
      const drifted = {
        ...source,
        state_records: source.state_records!.map((row) =>
          row.key === "issue:work-1"
            ? { ...row, body: String(row.body).replace("source", "sourcf") }
            : row,
        ),
      };
      const transport = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            await Promise.resolve();
            assert.ok(typeof input === "string");
            const request = new Request(input, init),
              url = new URL(request.url);
            if (url.pathname.endsWith("/status"))
              return Response.json({
                ok: true,
                value: { initialized: restored },
              });
            if (request.method === "POST") {
              restored = true;
              return Response.json({
                ok: true,
                value: {
                  page: 0,
                  done: true,
                  stopWindow: deltas[0]!.window,
                  restored: Object.fromEntries(
                    Object.entries(source).map(([t, rows]) => [t, rows.length]),
                  ),
                },
              });
            }
            if (url.pathname.includes("/source/")) seedRead = true;
            return Response.json({
              ok: true,
              value: page(
                url.pathname.includes("/target/")
                  ? target
                  : kind === "source drift" && sourceExports++ > 0
                    ? drifted
                    : source,
              ),
            });
          },
          { preconnect: () => {} },
        ),
      );
      try {
        const run = () =>
          compare(
            "source",
            "target",
            "stop fixture",
            16384,
            undefined,
            undefined,
            {
              fixture: kind === "observed source" ? source : original,
              seed:
                kind === "observed source"
                  ? false
                  : kind === "live callbacks"
                    ? () => {
                        assert.ok(seedRead, "metadata follows seed read");
                        return deltas[0]!;
                      }
                    : deltas[0]!,
              target:
                kind === "live callbacks" || kind === "observed source"
                  ? () => {
                      assert.ok(restored, "metadata follows target restore");
                      return deltas[1]!;
                    }
                  : deltas[1]!,
            },
          );
        if (
          kind === "correct" ||
          kind === "live callbacks" ||
          kind === "observed source"
        )
          await assert.doesNotReject(run);
        else {
          await assert.rejects(
            run,
            /stop|state_records|state_events|seed|expected image/i,
          );
          if (kind === "bad seed")
            assert.equal(
              restored,
              false,
              "seed verification precedes target restore",
            );
        }
      } finally {
        transport.mockRestore();
      }
      const scan = () => {
        const got = tally(undefined, stopPlan(source, deltas[1])),
          want = tally();
        for (const [table, rows] of Object.entries(target))
          for (const row of rows) {
            const cells = { ...row };
            Object.setPrototypeOf(cells, null);
            fold(got, table as Table, cells);
          }
        for (const [table, rows] of Object.entries(source))
          for (const row of rows) fold(want, table as Table, row);
        assert.deepEqual(
          digests(got),
          digests(want),
          "capacity six-table image",
        );
      };
      if (
        kind === "correct" ||
        kind === "live callbacks" ||
        kind === "observed source"
      )
        assert.doesNotThrow(scan);
      else assert.throws(scan, /stop|capacity|state_records|state_events/i);
    }
  },
  5000,
);

test("stop delta: swapped suffix across page boundaries is refused", () => {
  const source = fixture(false),
    target = inject(source, 1, false);
  const sum = digester(false, stopPlan(source, deltas[0]));
  for (const [table, rows] of Object.entries(target))
    if (table !== "state_events") sum.add(table, rows);
  sum.add("state_events", target.state_events!.slice(0, -2));
  assert.throws(() => {
    sum.add("state_events", [target.state_events!.at(-1)!]);
    sum.add("state_events", [target.state_events!.at(-2)!]);
    sum.done();
  }, /event.*order|suffix/i);
}, 1000);

async function capacityPlanner() {
  const path = new URL(
    "../../cloud/conformance/stop-capacity.ts",
    import.meta.url,
  );
  assert.ok(existsSync(path), "capacity stop planner is present");
  const module = (await import(path.href)) as {
    capacityStop: (
      pages: Iterable<{ tables: Tables }>,
      expected: Expected,
      observed: ReturnType<typeof stopObservation>,
    ) => NonNullable<ReturnType<typeof stopPlan>>;
  };
  return module.capacityStop;
}
async function capacityFloorCase(
  key: string | undefined,
  number: number,
  history: readonly unknown[] = [],
) {
  const sourceStore = scratchStorage(),
    targetStore = scratchStorage();
  const now = Date.now(),
    stamp = new Date(now).toISOString();
  try {
    const owner = new StateOwner(durableStore(sourceStore.storage), {
      now: () => now,
    });
    owner.initialize([domain]);
    for (const [revision, value] of history.entries())
      owner.put(namespace, FLOOR.key, value, actor, {
        expectRevision: revision,
      });
    if (history.length)
      owner.delete(namespace, FLOOR.key, actor, {
        expectRevision: history.length,
      });
    if (key)
      owner.put(namespace, key, { title: "record" }, actor, {
        expectRevision: 0,
      });
    owner.acquire(
      namespace,
      "issue:work-7",
      { actor, session: { id: "floor-lease" } },
      60_000,
      "acquire-floor-lease",
    );
    const source = tablesOf(sourceStore.db),
      sum = tally();
    assert.equal(source.state_leases!.length, 1);
    assert.equal(source.state_requests!.length, 1);
    for (const [table, rows] of Object.entries(source))
      for (const row of rows) fold(sum, table as Table, row);
    const expected = {
      floorSupplied: false,
      lastSequence: Number(source.state_events!.at(-1)!.sequence),
      tables: digests(sum),
    };
    const restored = replayImage(
      durableStore(targetStore.storage),
      [{ format: "forge-cloud-dump/2", tables: source }],
      now,
    );
    assert.ok(
      new LaneControlStore(restored, "cap").stop(
        { all: true },
        "cloud-restore",
        "cloud-restore",
        stamp,
      ).ok,
    );
    const actual = tablesOf(targetStore.db);
    const floor = actual.state_records!.find(
      (row) => row.namespace === FLOOR.namespace && row.key === FLOOR.key,
    )!;
    assert.equal(
      (JSON.parse(String(floor.body)) as { value: { number: number } }).value
        .number,
      number,
    );
    assert.equal(
      Number(floor.revision),
      history.length ? history.length + 2 : 1,
    );
    const observed = stopObservation([now, now]);
    observed.add(actual);
    const plan = (await capacityPlanner())([page(source)], expected, observed);
    const got = tally(expected, plan);
    for (const [table, rows] of Object.entries(actual))
      for (const row of rows) fold(got, table as Table, row);
    assert.deepEqual(
      problems(got, expected),
      [],
      "lease subjects do not advance the issue floor",
    );
  } finally {
    sourceStore.db.close();
    targetStore.db.close();
  }
}
test.each([
  ["lease only", undefined, 0],
  ["record plus lease", "issue:work-2", 2],
  ["noncanonical record plus lease", "issue:work-09", 0],
] as const)(
  "stop delta: capacity issue floor ignores lease subjects: %s",
  async (_label, key, number) => {
    await capacityFloorCase(key, number);
  },
  5000,
);
const prefix = "issue:work-";
test.each([
  ["wrong prefix", [{ prefix: "other-", number: 99 }], 0],
  ["extra property", [{ prefix, number: 99, extra: true }], 0],
  ["unsafe number", [{ prefix, number: 2 ** 53 }], 0],
  ["negative number", [{ prefix, number: -1 }], 0],
  [
    "valid then malformed",
    [
      { prefix, number: 4 },
      { prefix: "other-", number: 99 },
    ],
    4,
  ],
  ["valid reservation", [{ prefix, number: 4 }], 4],
] as const)(
  "stop delta: capacity deleted floor history: %s",
  async (_label, history, number) => {
    await capacityFloorCase(undefined, number, history);
  },
  5000,
);
test.each(["correct", "floor record", "floor event"] as const)(
  "stop delta: capacity planned %s",
  async (kind) => {
    const source = fixture(false),
      sum = tally();
    source.state_events![0]!.body = canonicalJson({
      type: "forge/work:record.updated@1",
      revision: 1,
      data: {},
    });
    for (const [table, rows] of Object.entries(source))
      for (const row of rows) fold(sum, table as Table, row);
    const expected = {
      floorSupplied: false,
      lastSequence: 9,
      tables: digests(sum),
    };
    const floor = record("allocation:issue:work-", {
      prefix: "issue:work-",
      number: 1,
    });
    const floorEvent = {
      sequence: 10,
      namespace,
      key: floor.key,
      body: canonicalJson({
        type: "forge/work:record.updated@1",
        namespace,
        key: floor.key,
        revision: 1,
        at,
        actor,
        data: { prefix: "issue:work-", number: 1 },
      }),
    };
    const planned = {
      ...source,
      state_records: [floor, ...source.state_records!],
      state_events: [...source.state_events!, floorEvent],
    };
    const actual = inject(planned, 1, false);
    const observed = stopObservation(deltas[0]!.window);
    for (const table of Object.keys(actual))
      observed.add({
        state_records: [],
        state_events: [],
        [table]: actual[table]!,
      });
    const plan = (await capacityPlanner())([page(source)], expected, observed);
    if (kind === "floor record")
      actual.state_records = actual.state_records!.map((row) =>
        row.key === floor.key ? { ...row, body: "{}" } : row,
      );
    if (kind === "floor event")
      actual.state_events = actual.state_events!.map((row) =>
        row.sequence === 10
          ? {
              ...row,
              body: canonicalJson({
                ...(JSON.parse(String(floorEvent.body)) as Record<
                  string,
                  unknown
                >),
                data: {},
              }),
            }
          : row,
      );
    const check = () => {
      const got = tally(expected, plan);
      for (const [table, rows] of Object.entries(actual))
        for (const row of rows) fold(got, table as Table, row);
      assert.deepEqual(
        problems(got, expected),
        [],
        "capacity floor comparison",
      );
    };
    if (kind === "correct") assert.doesNotThrow(check);
    else assert.throws(check, /floor|generated/i);
  },
  1000,
);

test.each([
  ["a 1 s clock offset passes", 1000, 0, 0, null],
  ["wider than the caller round trip fails", 0, 5000, 0, /restore stop window/],
  [
    "readback outside the returned window fails",
    1000,
    0,
    -1000,
    /stop request window/,
  ],
] as const)(
  "stop delta caller path: server window %s",
  async (_name, offset, width, readbackOffset, refusal) => {
    const original = fixture(false),
      source = inject(original, 1, false);
    let target: Tables | undefined,
      restored = false;
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          await Promise.resolve();
          assert.ok(typeof input === "string");
          const request = new Request(input, init),
            url = new URL(request.url);
          if (url.pathname.endsWith("/status"))
            return Response.json({
              ok: true,
              value: { initialized: restored },
            });
          if (request.method === "POST") {
            restored = true;
            const from = Date.now() + offset,
              window = [from, from + width] as const,
              readbackAt = new Date(from + readbackOffset).toISOString();
            target = inject(source, 2, false, readbackAt);
            return Response.json({
              ok: true,
              value: {
                page: 0,
                done: true,
                stopWindow: window,
                restored: Object.fromEntries(
                  Object.entries(source).map(([t, rows]) => [t, rows.length]),
                ),
              },
            });
          }
          if (url.pathname.includes("/target/")) {
            const tables = target;
            assert.ok(tables, "target readback follows restore");
            return Response.json({ ok: true, value: page(tables) });
          }
          return Response.json({ ok: true, value: page(source) });
        },
        { preconnect: () => {} },
      ),
    );
    const previous = process.env.CLOUD_RESTORE_STOP;
    process.env.CLOUD_RESTORE_STOP = "1";
    try {
      const run = () =>
        compare(
          "source",
          "target",
          "stop caller path",
          16384,
          undefined,
          undefined,
          {
            fixture: original,
            seed: deltas[0]!,
            target: () => {
              const [live] = restoreObservers;
              assert.ok(live, "restore caller observation");
              return live.get("target")!;
            },
          },
        );
      if (refusal === null) await assert.doesNotReject(run);
      else await assert.rejects(run, refusal);
    } finally {
      if (previous === undefined) delete process.env.CLOUD_RESTORE_STOP;
      else process.env.CLOUD_RESTORE_STOP = previous;
      transport.mockRestore();
    }
  },
  5000,
);
