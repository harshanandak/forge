import assert, {
  deepStrictEqual as eq,
  notDeepStrictEqual as ne,
} from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { Project, domain } from "../../cloud/src/project.ts";
import { durableStore } from "../../cloud/src/store.ts";
import {
  limitsFrom,
  parseDump,
  restorePage,
  type Page,
} from "../../cloud/src/dump.ts";
import { TABLES } from "../../cloud/conformance/digest.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { success } from "../../src/surface/dispatch.ts";
import { failure, respond } from "../../src/surface/result.ts";
import { consumeLaneApproval } from "../../cloud/src/lane-approval.ts";
import { browserStorage } from "./browser-storage.fixture.ts";
import * as f from "./import-current-state.fixture.ts";
import * as converter from "../../tools/import-current.ts";
import { pagesOf } from "../../tools/import-current-state.ts";

const rows = [
  ["Offline bundle", "bundle", "OK", 0, null],
  ["CF source pin", "pin", "FAIL", 6, "INPUT_INVALID"],
  ["CF all-row readback", "readback", "FAIL", 6, "INPUT_INVALID"],
  ["CF authority payload", "authority", "FAIL", 6, "INPUT_INVALID"],
  ["Output exists or write fails", "write", "FAIL", 1, "UNAVAILABLE"],
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
async function result(body: () => unknown | Promise<unknown>) {
  try {
    return respond(success("import-current", await body()));
  } catch (error) {
    if (!(error instanceof Error) || !("error" in error)) throw error;
    const e = error.error as { code: string; message: string };
    return respond(failure(e.code, e.message));
  }
}
type Change = readonly [string, string];
async function moduleUrl(
  path: string,
  changes: Change[] = [],
  dependency?: Change,
) {
  const url = new URL(path, import.meta.url);
  let text = (await Bun.file(url).text()).replaceAll("\r\n", "\n");
  for (const change of changes) {
    eq(text.split(change[0]).length, 2, `mutation anchor ${change[0]}`);
    text = text.replace(...change);
  }
  text = text.replace(
    /from "(\.\.?\/[^"]+)"/g,
    (_all, spec: string) =>
      `from "${dependency?.[0] === spec ? dependency[1] : new URL(spec, url).href}"`,
  );
  return `data:text/javascript;base64,${Buffer.from(new Bun.Transpiler({ loader: "ts" }).transformSync(text)).toString("base64")}`;
}
const compareGuard =
  "JSON.stringify(imageDigests(target)) !== JSON.stringify(expected)";
const pinGuard = "(await digest(backup)) !== manifest.sha256";
const limits = { ...limitsFrom({}), pageBytes: 4096 };
async function project(mutant?: string) {
  const changes: Change[] =
    mutant === "order"
      ? [["page.page !== staged?.next", "false"]]
      : mutant === "target"
        ? [
            [
              'if (await this.#isProvisioned())\n      throw new ForgeFailure({\n        code: "RESTORE_TARGET_NOT_EMPTY",',
              'if (false)\n      throw new ForgeFailure({\n        code: "RESTORE_TARGET_NOT_EMPTY",',
            ],
          ]
        : [];
  const dump =
    mutant === "release"
      ? await moduleUrl("../../cloud/src/dump.ts", [
          ["owner.releaseRestoredLeases();", ""],
        ])
      : undefined;
  const Impl =
    changes.length || dump
      ? (
          (await import(
            await moduleUrl(
              "../../cloud/src/project.ts",
              changes,
              dump ? ["./dump.ts", dump] : undefined,
            )
          )) as { Project: typeof Project }
        ).Project
      : Project;
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

// Each CF runs the original guard and its removal against the same synthetic bad input.
test.each(rows)(
  "%s",
  async (name, kind, expectedStatus, exit, code) => {
    const variants =
      kind === "pin"
        ? ["wrong", "changed"]
        : kind === "readback"
          ? ["drop", "value", "invalid"]
          : kind === "authority"
            ? ["lease", "request", "legacy"]
            : kind === "write"
              ? ["exists", "interrupted"]
              : [kind];
    for (const variant of variants)
      for (const mutant of name.startsWith("CF") ? [false, true] : [false]) {
        const s = f.source(
          kind === "bundle" ? 7366 : 9,
          false,
          kind === "release",
        );
        const backup = String(s.db.all("PRAGMA database_list")[0]!.file),
          root = dirname(backup);
        const out = join(root, `bundle-${variant}-${mutant}`),
          manifestPath = join(root, "source.json");
        const before = f.snapshot(s.db),
          hash = s.bytes();
        const manifest = {
          ...s.manifest,
          ...(kind === "pin" && variant === "wrong"
            ? { sha256: "0".repeat(64) }
            : {}),
        };
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const options = { backup, manifest: manifestPath, out, limits };
        if (
          ["bundle", "pin", "readback", "authority", "write"].includes(kind)
        ) {
          const edits: Change[] = [];
          if (kind === "pin" && variant === "changed")
            edits.push([
              "const expected = imageDigests(scratch);",
              "const expected = imageDigests(scratch); writeFileSync(backup, Buffer.concat([readFileSync(backup), Buffer.from([0])]));",
            ]);
          if (kind === "pin" && mutant)
            edits.push(
              [pinGuard, "false"],
              ["(await digest(backup)) !== manifest.sha256", "false"],
            );
          if (kind === "readback") {
            const alter =
              variant === "drop"
                ? "delete data.tables.state_records[0]; data.tables.state_records = data.tables.state_records.filter(Boolean); data.tables.state_events = data.tables.state_events.filter(r => r.key !== 'issue:work-1');"
                : "for (const row of data.tables.state_records) if(row.key === 'issue:work-1') row.body = row.body.replace('Synthetic 1', 'Changed 1'); for (const row of data.tables.state_events) if(row.key === 'issue:work-1') row.body = row.body.replace('Synthetic 1', 'Changed 1');";
            edits.push([
              'writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });',
              `const data = JSON.parse(bytes); if(page.page === 0) { ${variant === "invalid" ? "for (const row of data.tables.state_records) row.body = '{}';" : alter} } bytes = JSON.stringify(data); writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });`,
            ]);
            if (mutant) {
              edits.push([compareGuard, "false"]);
              if (variant === "invalid") {
                const dump = await moduleUrl("../../cloud/src/dump.ts", [
                  [
                    "if (page.last) settleFloor(db, owner, limits, verifyRestored(db));",
                    "",
                  ],
                ]);
                const url = await moduleUrl(
                  "../../tools/import-current.ts",
                  edits,
                  ["../cloud/src/dump.ts", dump],
                );
                const impl = (await import(url)) as typeof converter;
                const r = await impl.run(options);
                ne(status(r), ["FAIL", 1, "RESTORE_INVALID_ROW"]);
                continue;
              }
            }
          }
          if (kind === "authority") {
            const inject =
              variant === "lease"
                ? "new StateOwner(scratch).acquire('forge/work','issue:work-1',{actor:{kind:'agent',id:'synthetic'},session:{id:'one',device:'fixture'}},60000);"
                : variant === "request"
                  ? "new StateOwner(scratch).put('forge/work','issue:work-1',{title:'receipt'}, {kind:'agent',id:'synthetic'},{expectRevision:1,requestId:'old-request'});"
                  : "scratch.run(\"INSERT INTO domain_cloud_requests VALUES ('legacy','{}','ok','{}')\");";
            edits.push([
              "for (const page of pagesOf(scratch, limits)) {",
              `${inject}\n    for (const page of pagesOf(scratch, limits)) {`,
            ]);
            if (mutant) edits.push([compareGuard, "false"]);
          }
          if (kind === "write") {
            if (variant === "exists") {
              mkdirSync(out);
              writeFileSync(join(out, "keep"), "untouched");
            } else
              edits.push([
                'writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });',
                "writeFileSync(file, bytes.slice(0, 12), { flag: 'wx', mode: 0o600 }); throw new Error('interrupted synthetic write');",
              ]);
          }
          const impl = edits.length
            ? ((await import(
                await moduleUrl("../../tools/import-current.ts", edits)
              )) as typeof converter)
            : converter;
          const r = await impl.run(options);
          const want =
            kind === "readback" && variant === "invalid"
              ? ["FAIL", 1, "RESTORE_INVALID_ROW"]
              : [expectedStatus, exit, code];
          if (mutant) ne(status(r), want);
          else eq(status(r), want);
          if (!r.envelope.ok) {
            eq(existsSync(join(out, "manifest.json")), false);
            if (kind === "write" && variant === "exists")
              eq(readFileSync(join(out, "keep"), "utf8"), "untouched");
          } else if (!mutant) {
            const bundle = JSON.parse(
              readFileSync(join(out, "manifest.json"), "utf8"),
            ) as ReturnType<typeof JSON.parse>;
            eq(bundle.activation, "requires-step-8-stop");
            eq(bundle.N, 7366);
            eq(bundle.rows.state_records, bundle.N + bundle.F);
            eq(Object.keys(bundle.tables), [...TABLES]);
            for (const table of TABLES.slice(2))
              eq(bundle.tables[table].rows, 0);
            for (const p of bundle.pages) {
              const bytes = readFileSync(join(out, p.name));
              eq(bytes.byteLength, p.bytes);
              eq(await converter.digest(join(out, p.name)), p.sha256);
            }
            eq(readdirSync(out).length, bundle.pages.length + 1);
            eq(status(await impl.run(options)), ["FAIL", 1, "UNAVAILABLE"]);
          }
          eq(f.snapshot(s.db), before);
          if (!(kind === "pin" && variant === "changed")) eq(s.bytes(), hash);
          continue;
        }
        const scratch = f.database();
        f.owner(scratch).initialize();
        if (kind === "release") {
          const state = f.owner(scratch);
          state.initialize([domain]);
          // Existing-format replay includes its live lease and original request history.
          for (const table of [
            "state_records",
            "state_events",
            "state_leases",
            "state_requests",
          ]) {
            for (const row of s.db.all(`SELECT * FROM ${table}`))
              scratch.run(
                `INSERT INTO ${table} VALUES (${Object.keys(row)
                  .map(() => "?")
                  .join(",")})`,
                Object.values(row),
              );
          }
        } else
          (await f.implementation()).currentState(
            s.db,
            scratch,
            s.manifest,
            limits,
          );
        const pages = [...pagesOf(scratch, limits)];
        assert.ok(pages.length > 2);
        const p = await project(mutant ? kind : undefined);
        try {
          if (kind === "target") {
            await p.send("devices", { device: "synthetic", ttlMs: 60000 });
            const saved = JSON.stringify([
              p.db.query("SELECT name FROM sqlite_master ORDER BY name").all(),
              [...p.values],
            ]);
            const r = await p.send("restore", pages[0]);
            if (mutant) ne(status(r.projected), [expectedStatus, exit, code]);
            else {
              eq(status(r.projected), [expectedStatus, exit, code]);
              eq(
                JSON.stringify([
                  p.db
                    .query("SELECT name FROM sqlite_master ORDER BY name")
                    .all(),
                  [...p.values],
                ]),
                saved,
              );
            }
          } else if (kind === "order") {
            await p.send("restore", pages[0]);
            const r = await p.send("restore", pages[2]);
            if (mutant) ne(status(r.projected), [expectedStatus, exit, code]);
            else {
              eq(status(r.projected), [expectedStatus, exit, code]);
              eq(p.values.has("restore:next"), false);
              for (const table of TABLES)
                eq(p.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(), {
                  n: 0,
                });
            }
            eq(p.values.get("provisioned"), undefined);
          } else if (kind === "approval") {
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
            const edits: Change[] = mutant
              ? [
                  [
                    "Object.keys(tables).length !== Object.keys(TABLES).length",
                    "false",
                  ],
                ]
              : [];
            const dump = (await import(
              await moduleUrl("../../cloud/src/dump.ts", edits)
            )) as typeof import("../../cloud/src/dump.ts");
            const r = await result(() => dump.parseDump(JSON.stringify(extra)));
            if (mutant) ne(status(r), [expectedStatus, exit, code]);
            else eq(status(r), [expectedStatus, exit, code]);
            eq(p.values.get("provisioned"), undefined);
          } else {
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
              eq(
                p.db
                  .query("SELECT COUNT(*) AS n FROM domain_cloud_tokens")
                  .get(),
                { n: 0 },
              );
            } else {
              eq(p.values.get("provisioned"), true);
              const target = durableStore(p.storage),
                owner = f.owner(target);
              if (kind === "release") {
                const lease = owner.lease(f.ns, "issue:work-1")!;
                eq(lease.generation, 1);
                eq(lease.releasedAt !== undefined, !mutant);
                const held = f.result(() =>
                  owner.put(f.ns, "issue:work-1", { stale: true }, f.actor, {
                    expectRevision: 1,
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
              } else {
                eq(
                  converter.imageDigests(target),
                  converter.imageDigests(scratch),
                );
                for (const table of [
                  ...TABLES.slice(2),
                  "domain_cloud_lane_approvals",
                ])
                  eq(target.get(`SELECT COUNT(*) AS n FROM ${table}`), {
                    n: 0,
                  });
                if (kind === "old") {
                  const state = f.snapshot(target);
                  const r = await result(() =>
                    consumeLaneApproval(
                      target,
                      "old-owner-approval",
                      { all: true },
                      { now: f.at } as Parameters<
                        typeof consumeLaneApproval
                      >[3],
                    ),
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
                  const r = await p.send(
                    `dump?cursor=${encodeURIComponent(cursor)}`,
                  );
                  assert.ok(r.r.ok);
                  const page = parseDump(JSON.stringify(r.r.value)) as Page;
                  restorePage(readback, reader, page, limits);
                  if (page.next === null) break;
                  cursor = page.next;
                }
                eq(
                  converter.imageDigests(readback),
                  converter.imageDigests(scratch),
                );
              }
            }
          }
          eq(f.snapshot(s.db), before);
          eq(s.bytes(), hash);
        } finally {
          p.db.close();
        }
      }
  },
  120_000,
);
