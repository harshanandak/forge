import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, setSystemTime, spyOn, test } from "bun:test";
import { domain } from "../../cloud/src/project.ts";
import { durableStore } from "../../cloud/src/store.ts";
import {
  limitsFrom,
  parseDump,
  restorePage,
  dumpOf,
  type Page,
} from "../../cloud/src/dump.ts";
import { imageProblems, TABLES } from "../../cloud/conformance/digest.ts";
import { replayImage } from "../../cloud/conformance/restored.ts";
import { pagesOf as cut } from "../../cloud/conformance/max-source.ts";
import { pageOrder } from "../../cloud/conformance/page-order.ts";
import { success } from "../../src/surface/dispatch.ts";
import { failure, respond } from "../../src/surface/result.ts";
import { consumeLaneApproval } from "../../cloud/src/lane-approval.ts";
import { browserStorage } from "./browser-storage.fixture.ts";
import * as f from "./import-current-state.fixture.ts";
import * as converter from "../../tools/import-current.ts";
import { currentState, pagesOf } from "../../tools/import-current-state.ts";

const eq: typeof assert.deepStrictEqual = assert.deepStrictEqual;
const ne: typeof assert.notDeepStrictEqual = assert.notDeepStrictEqual;
test("numeric page order crosses four digits", () => {
  eq(["page-10000.json", "page-9999.json"].sort(pageOrder), [
    "page-9999.json",
    "page-10000.json",
  ]);
}, 1000);
beforeEach(() => setSystemTime(f.at));
afterEach(() => setSystemTime());
const rows = [
  ["Intermediate restore page", "intermediate", "OK", 0, null],
  ["CF page order", "order", "FAIL", 6, "INPUT_INVALID"],
  ["CF target-empty guard", "target", "FAIL", 1, "RESTORE_TARGET_NOT_EMPTY"],
  ["Final disposable restore", "final", "OK", 0, null],
  ["CF ordinary restore lease release", "release", "OK", 0, null],
  ["CF approval exclusion", "approval", "FAIL", 6, "INPUT_INVALID"],
  ["Old approval on new target", "old", "FAIL", 1, "APPROVAL_REQUIRED"],
] as const;
const status = (r: ReturnType<typeof respond>) => [
  r.envelope.status,
  r.exitCode,
  r.envelope.ok ? null : r.envelope.error.code,
];
const limits = { ...limitsFrom({}), pageBytes: 4096 };

function comparisonSource() {
  const source = f.cloudDatabase(),
    owner = f.owner(source);
  owner.initialize([domain]);
  owner.put(f.ns, "issue:work-1", { title: "source" }, f.actor, {
    expectRevision: 0,
  });
  owner.put(
    f.ns,
    "allocation:issue:work-",
    { prefix: "issue:work-", number: 1 },
    f.actor,
    { expectRevision: 0 },
  );
  return source;
}

test("comparison plumbing replays source unchanged and compares a distinct expected image", () => {
  const source = comparisonSource();
  const before = f.snapshot(source),
    original = converter.imageDigests(source);
  for (const paged of [false, true]) {
    const scratch = f.cloudDatabase();
    const expected = replayImage(
      scratch,
      paged ? pagesOf(source, limits) : [dumpOf(source)],
      f.at,
    );
    eq(converter.imageDigests(scratch), original);
    eq(imageProblems(original, converter.imageDigests(scratch)), []);
    expected.put(f.ns, "issue:work-1", { title: "expected" }, f.actor, {
      expectRevision: 1,
    });
    eq(imageProblems(original, converter.imageDigests(scratch)), [
      "state_records holds the right row count but different content",
      "state_events has 2 rows besides the generated floor, the expected image had 3",
    ]);
    eq(f.snapshot(source), before);
  }
}, 5_000);

test("expected replay refuses empty, unordered and non-final streams", async () => {
  const source = comparisonSource(),
    split = cut(dumpOf(source).tables, 3);
  eq(split.length, 2);
  for (const image of [
    [],
    split.slice(0, 1),
    [split[1]!, split[0]!],
    [...split, split[1]!],
    [{ ...split[0]!, last: true }],
  ])
    assert.throws(() => replayImage(f.cloudDatabase(), image, f.at), {
      code: "INCOMPLETE_IMAGE",
    });
  const mutant = (await import(
    await f.moduleUrl("../../cloud/conformance/restored.ts", [
      "if (!complete)",
      "if (false)",
    ])
  )) as typeof import("../../cloud/conformance/restored.ts");
  assert.throws(() =>
    assert.throws(
      () => mutant.replayImage(f.cloudDatabase(), split.slice(0, 1), f.at),
      { code: "INCOMPLETE_IMAGE" },
    ),
  );
}, 5_000);

const comparisonGuard = `  assert.deepEqual(
    back.done(),
    expected === source ? digests : image.done(),
    \`\${label}: target differs from expected image\`,
  );`;
test.each(["distinct", "corrupt", "truncated"])(
  "roundTrip %s catches its guard removal",
  async (kind) => {
    for (const mutant of [false, true]) {
      const source = comparisonSource(),
        document = dumpOf(source),
        before = f.snapshot(source);
      const src = await project(),
        dst = await project();
      eq(status((await src.send("restore", document)).projected), [
        "OK",
        0,
        null,
      ]);
      const expected = cut(
        JSON.parse(
          JSON.stringify(document.tables).replaceAll(
            "source",
            kind === "distinct" ? "expect" : "source",
          ),
        ) as typeof document.tables,
        3,
      );
      eq(expected.length, 2);
      const stream = kind === "truncated" ? expected.slice(0, 1) : expected;
      const changes: Record<string, readonly [string, string]> = {
        distinct: ["expected === source ? digests : image.done()", "digests"],
        corrupt: [comparisonGuard, ""],
        truncated: ["    sequence();", ""],
      };
      const impl = (await import(
        await f.moduleUrl(
          "../../cloud/conformance/conformance.ts",
          mutant ? changes[kind] : undefined,
        )
      )) as typeof import("../../cloud/conformance/conformance.ts");
      const transport = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            assert.ok(typeof input === "string");
            const request = new Request(input, init),
              url = new URL(request.url),
              name = url.pathname.split("/")[2];
            assert.ok(name === "source" || name === "target");
            if (name === "source") return src.p.fetch(request);
            if (kind === "truncated" && url.pathname.endsWith("/dump"))
              return Response.json({
                ok: true,
                value: { ...expected[0]!, last: true, next: null },
              });
            if (kind !== "truncated" && request.method === "POST") {
              const body = await request.text();
              eq(body.split("source").length, 3);
              return dst.p.fetch(
                new Request(request, {
                  body: body.replaceAll(
                    "source",
                    kind === "distinct" ? "expect" : "sourcf",
                  ),
                }),
              );
            }
            return dst.p.fetch(request);
          },
          { preconnect: () => {} },
        ),
      );
      try {
        const run = () =>
          impl.roundTrip(
            "source",
            "target",
            "comparison",
            4096,
            undefined,
            stream,
          );
        const check = () =>
          kind === "distinct"
            ? assert.doesNotReject(run)
            : assert.rejects(run, {
                code:
                  kind === "truncated" ? "INCOMPLETE_IMAGE" : "ERR_ASSERTION",
              });
        if (mutant) await assert.rejects(check);
        else await check();
        eq(f.snapshot(source), before);
      } finally {
        transport.mockRestore();
        src.db.close();
        dst.db.close();
      }
    }
  },
  30_000,
);

test.each(["distinct", "corrupt"])(
  "constructed expected image through roundTrip: %s",
  async (kind) => {
    for (const mutant of [false, true]) {
      const source = comparisonSource(),
        document = dumpOf(source),
        before = f.snapshot(source);
      const src = await project(),
        dst = await project();
      eq(status((await src.send("restore", document)).projected), [
        "OK",
        0,
        null,
      ]);
      const construction = (await import(
        await f.moduleUrl(
          "../../cloud/conformance/restored.ts",
          mutant && kind === "distinct"
            ? ["    await delta(owner);", ""]
            : undefined,
        )
      )) as typeof import("../../cloud/conformance/restored.ts");
      const comparison = (await import(
        await f.moduleUrl(
          "../../cloud/conformance/conformance.ts",
          mutant && kind === "corrupt" ? [comparisonGuard, ""] : undefined,
        )
      )) as typeof import("../../cloud/conformance/conformance.ts");
      const transport = spyOn(globalThis, "fetch").mockImplementation(
        f.expectedTransport(src.p, dst.p, () =>
          f.controlDelta(
            f.owner(durableStore(dst.storage)),
            kind === "distinct" ? "expect" : "sourcf",
          ),
        ),
      );
      try {
        const expected = construction.expectedImage([document], f.at, (owner) =>
          f.controlDelta(owner, kind === "distinct" ? "expect" : "source"),
        );
        const run = () =>
          comparison.roundTrip(
            "source",
            "target",
            "constructed",
            4096,
            undefined,
            expected,
          );
        const check = () =>
          kind === "distinct"
            ? assert.doesNotReject(run)
            : assert.rejects(run, { code: "ERR_ASSERTION" });
        if (mutant) await assert.rejects(check);
        else await check();
        eq(f.snapshot(source), before);
      } finally {
        transport.mockRestore();
        src.db.close();
        dst.db.close();
      }
    }
  },
  30_000,
);

async function project(mutant?: string) {
  const edits: Record<string, readonly [string, string]> = {
    order: ["page.page !== staged?.next", "false"],
    target: ["if (await this.#isProvisioned())", "if (false)"],
  };
  const dump =
    mutant === "release"
      ? await f.moduleUrl("../../cloud/src/dump.ts", [
          "owner.releaseRestoredLeases();",
          "",
        ])
      : undefined;
  const { Project: Impl } = (await import(
    await f.moduleUrl(
      "../../cloud/src/project.ts",
      edits[mutant ?? ""],
      dump ? ["./dump.ts", dump] : undefined,
    )
  )) as typeof import("../../cloud/src/project.ts");
  const db = new Database(":memory:");
  const { storage, values } = browserStorage(db);
  const p = new Impl({ storage }, { DUMP_PAGE_BYTES: "4096" });
  const send = async (route: string, body?: unknown) => {
    const response = await p.fetch(
      new Request(`https://synthetic.example/p/a/${route}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const r = (await response.json()) as {
      ok: boolean;
      value: Record<string, unknown>;
      error: { code: string; message: string };
    };
    return {
      r,
      projected: respond(
        r.ok
          ? success("restore", r.value)
          : failure(r.error.code, r.error.message),
      ),
    };
  };
  return { db, storage, values, send, p };
}

test.each(rows)(
  "%s",
  async (name, kind, expectedStatus, exit, code) => {
    for (const mutant of name.startsWith("CF") ? [false, true] : [false]) {
      const s = f.source(30, false, kind === "release");
      const before = [f.snapshot(s.db), s.bytes()];
      const scratch = kind === "release" ? f.cloudDatabase() : f.database();
      f.owner(scratch).initialize(kind === "release" ? [domain] : []);
      if (kind === "release") {
        // Existing-format replay includes its live lease and original request history.
        for (const table of TABLES.slice(0, 4)) {
          for (const row of s.db.all(`SELECT * FROM ${table}`))
            scratch.run(
              `INSERT INTO ${table} VALUES (${Object.keys(row)
                .map(() => "?")
                .join(",")})`,
              Object.values(row),
            );
        }
      } else currentState(s.db, scratch, s.manifest, limits);
      const pages = [...pagesOf(scratch, limits)];
      assert.ok(pages.length > 2);
      const p = await project(mutant ? kind : undefined);
      const target = durableStore(p.storage);
      const count = (table: string) =>
        Number(target.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
      const expected = [expectedStatus, exit, code];
      const check = (r: ReturnType<typeof respond>) =>
        (mutant ? ne : eq)(status(r), expected);
      try {
        await (async () => {
          if (kind === "target") {
            await p.send("devices", { device: "synthetic", ttlMs: 60000 });
            const snapshot = () => [
              f.snapshot(target),
              [...p.values],
              p.db.query("SELECT * FROM sqlite_master ORDER BY name").all(),
            ];
            const saved = snapshot();
            const r = await p.send("restore", pages[0]);
            check(r.projected);
            if (!mutant) eq(snapshot(), saved);
            return;
          }
          if (kind === "order") {
            await p.send("restore", pages[0]);
            const r = await p.send("restore", pages[2]);
            check(r.projected);
            if (!mutant) {
              eq(p.values.has("restore:next"), false);
              for (const table of TABLES) eq(count(table), 0);
            }
            eq(p.values.get("provisioned"), undefined);
            return;
          }
          if (kind === "approval") {
            const extra = {
              ...pages[0],
              tables: {
                ...pages[0]!.tables,
                domain_cloud_lane_approvals: [
                  { id: 1, state: '{"status":"approved"}' },
                ],
                domain_cloud_browser_challenges: [],
              },
            };
            const dump = (await import(
              await f.moduleUrl(
                "../../cloud/src/dump.ts",
                mutant
                  ? [
                      "Object.keys(given).sort().join() !== [...names].sort().join()",
                      "false",
                    ]
                  : undefined,
              )
            )) as typeof import("../../cloud/src/dump.ts");
            const r = f.result(() => dump.parseDump(JSON.stringify(extra)));
            check(r);
            eq(p.values.get("provisioned"), undefined);
            return;
          }
          let last: Awaited<ReturnType<typeof p.send>> | undefined;
          for (const page of kind === "intermediate"
            ? pages.slice(0, 1)
            : pages)
            last = await p.send("restore", page);
          eq(status(last!.projected), ["OK", 0, null]);
          if (kind === "intermediate") {
            eq(p.values.get("provisioned"), undefined);
            eq(p.values.get("restore:next"), {
              next: 1,
              format: pages[0]!.format,
            });
            eq(count("domain_cloud_tokens"), 0);
            return;
          }
          eq(p.values.get("provisioned"), true);
          const owner = f.owner(target);
          if (kind === "release") {
            const lease = owner.lease(f.ns, "issue:work-1")!;
            eq(lease.generation, 1);
            eq(lease.releasedAt !== undefined, !mutant);
            const held = f.result(() =>
              owner.put(f.ns, "issue:work-1", { stale: true }, f.actor, {
                expectRevision: 2,
                fence: {
                  subject: "issue:work-1",
                  holder: f.holder,
                  generation: 1,
                },
              }),
            );
            eq(
              status(held),
              mutant ? ["OK", 0, null] : ["FAIL", 4, "LEASE_NOT_HELD"],
            );
            return;
          }
          const expected = converter.imageDigests(scratch);
          for (const table of [
            ...TABLES.slice(2),
            "domain_cloud_lane_approvals",
          ])
            eq(count(table), 0);
          if (kind === "old") {
            const state = f.snapshot(target);
            const r = f.result(() =>
              consumeLaneApproval(target, "old-owner-approval", { all: true }, {
                now: f.at,
              } as Parameters<typeof consumeLaneApproval>[3]),
            );
            eq(status(r), [expectedStatus, exit, code]);
            eq(f.snapshot(target), state);
          }
          // Read every target table through the real paged export, not its restore response.
          const readback = f.cloudDatabase(),
            reader = f.owner(readback);
          reader.initialize([domain]);
          let cursor = "start";
          for (;;) {
            const r = await p.send(`dump?cursor=${encodeURIComponent(cursor)}`);
            assert.ok(r.r.ok);
            const page = parseDump(JSON.stringify(r.r.value)) as Page;
            restorePage(readback, reader, page, limits);
            if (page.next === null) break;
            cursor = page.next;
          }
          eq(converter.imageDigests(readback), expected);
        })();
        eq([f.snapshot(s.db), s.bytes()], before);
      } finally {
        p.db.close();
      }
    }
  },
  120_000,
);
