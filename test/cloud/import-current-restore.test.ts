import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, setSystemTime, test } from "bun:test";
import { domain } from "../../cloud/src/project.ts";
import { durableStore } from "../../cloud/src/store.ts";
import {
  limitsFrom,
  parseDump,
  restorePage,
  type Page,
} from "../../cloud/src/dump.ts";
import { TABLES } from "../../cloud/conformance/digest.ts";
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
  return { db, storage, values, send };
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
