import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { roundTrip } from "../../cloud/conformance/conformance.ts";
import { SHAPE, type Tables } from "../../cloud/conformance/max-source.ts";
import { stopPlan } from "../../cloud/conformance/restored.ts";
import {
  tally,
  fold,
  digests,
  type Table,
} from "../../cloud/conformance/digest.ts";

const at = "2027-01-15T08:00:00.000Z";
const actor = { kind: "agent", id: "cloud-restore" };
const namespace = "forge/work";
const incarnation = "11111111-1111-4111-8111-111111111111";
const deltas = [1, 2].map((n) => ({
  at,
  incarnation,
  auditId: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
  window: [Date.parse(at) - 1, Date.parse(at) + 1] as const,
}));
const record = (key: string, value: unknown, revision = 1) => ({
  namespace,
  key,
  revision,
  body: canonicalJson({
    namespace,
    key,
    revision,
    value,
    updatedAt: at,
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
function inject(source: Tables, n: number, prior: boolean): Tables {
  const epoch = (prior ? 7 : 0) + n,
    revision = (prior ? 3 : 0) + n;
  const global = record(
    "lane-control:global",
    {
      version: 1,
      incarnation,
      epoch,
      resumeAllEpoch: prior ? 5 : 0,
      stopAll: at,
    },
    revision,
  );
  const audit = record(`lane-control:audit:${deltas[n - 1]!.auditId}`, {
    version: 1,
    action: "stop",
    scope: { all: true },
    device: "cloud-restore",
    session: "cloud-restore",
    at,
    incarnation,
    epoch,
  });
  const events = [global, audit].map((row, i) => ({
    sequence: Number(source.state_events!.at(-1)!.sequence) + i + 1,
    namespace,
    key: row.key,
    body: canonicalJson({
      type: "forge/work:record.updated@1",
      namespace,
      key: row.key,
      revision: row.revision,
      at,
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
  seed: (typeof deltas)[number];
  target: (typeof deltas)[number];
};
// Main ignores the extra parameter: red is a comparison assertion, not an import failure.
const compare = roundTrip as (
  source: string,
  target: string,
  label: string,
  budget: number,
  each: undefined,
  expected: undefined,
  comparison: Comparison,
) => ReturnType<typeof roundTrip>;
const cases = [
  "correct",
  "duplicate event",
  "missing event",
  "wrong epoch",
  "missing audit",
  "imported lane",
  "dropped row",
  "changed byte",
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
      if (kind === "imported lane" || kind === "changed byte") {
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
                  restored: Object.fromEntries(
                    Object.entries(source).map(([t, rows]) => [t, rows.length]),
                  ),
                },
              });
            }
            return Response.json({
              ok: true,
              value: page(url.pathname.includes("/target/") ? target : source),
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
            { fixture: original, seed: deltas[0]!, target: deltas[1]! },
          );
        if (kind === "correct") await assert.doesNotReject(run);
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
          for (const row of rows) fold(got, table as Table, row);
        for (const [table, rows] of Object.entries(source))
          for (const row of rows) fold(want, table as Table, row);
        assert.deepEqual(
          digests(got),
          digests(want),
          "capacity six-table image",
        );
      };
      if (kind === "correct") assert.doesNotThrow(scan);
      else assert.throws(scan, /stop|capacity|state_records|state_events/i);
    }
  },
  5000,
);
