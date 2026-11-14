import { test } from "bun:test";
import {
  deepStrictEqual as eq,
  notDeepStrictEqual as ne,
} from "node:assert/strict";
import {
  limitsFrom,
  parseDump,
  restorePage,
  type Page,
} from "../../cloud/src/dump.ts";
import { domain } from "../../cloud/src/project.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import * as f from "./import-current-state.fixture.ts";
const limits = limitsFrom({});
const rows = [
  ["Full current fixture", "full", "OK", 0, null],
  ["Missing number floors", "missing", "OK", 0, null],
  ["CF historical floor", "historical", "OK", 0, null],
  ["CF source consistency", "consistency", "FAIL", 6, "INPUT_INVALID"],
  ["CF supported scope", "scope", "FAIL", 6, "INPUT_INVALID"],
  ["CF exact count", "count", "FAIL", 6, "INPUT_INVALID"],
  ["CF one-event revision", "revision", "FAIL", 1, "RESTORE_INVALID_ROW"],
  ["CF empty scratch", "empty", "FAIL", 6, "INPUT_INVALID"],
  ["CF no authority transfer", "authority", "OK", 0, null],
  ["CF old fence", "fence", "FAIL", 4, "LEASE_NOT_HELD"],
  ["Projection exceeds caps", "caps", "FAIL", 1, "RESTORE_TOO_LARGE"],
] as const;
const status = (r: ReturnType<typeof f.result>) => [
  r.envelope.status,
  r.exitCode,
  r.envelope.ok ? null : r.envelope.error.code,
];
test.each(rows)(
  "%s",
  async (_name, kind, expectedStatus, exit, code) => {
    const cf = _name.startsWith("CF");
    const variants =
      kind === "scope"
        ? ["namespace", "journal", "approval", "migration"]
        : kind === "caps"
          ? ["rows", "bytes"]
          : [kind];
    for (const variant of variants)
      for (const mutant of cf ? [false, true] : [false]) {
        const historical = ["missing", "historical"].includes(kind);
        const authority = ["authority", "fence"].includes(kind);
        const source = f.source(
          kind === "full" ? 7366 : kind === "count" ? 7365 : 6,
          historical,
          authority,
          (db, state) => {
            if (kind === "consistency")
              db.run(
                "UPDATE state_records SET body=json_set(body,'$.value.title','changed') WHERE key='issue:work-1'",
              );
            if (kind === "scope") {
              if (variant === "migration")
                db.run("INSERT INTO state_migrations VALUES ('999_unknown')");
              else
                state.put(
                  variant === "namespace" ? "forge/cloud" : f.ns,
                  variant === "namespace" ? "request:old" : `${variant}:work-1`,
                  { unknown: true },
                  f.actor,
                  { expectRevision: 0 },
                );
            }
          },
        );
        const before = f.snapshot(source.db),
          digest = source.bytes();
        const scratch = f.database(),
          state = f.owner(scratch);
        state.initialize();
        if (kind === "empty")
          state.put(f.ns, "issue:work-1", { keep: true }, f.actor, {
            expectRevision: 0,
          });
        const scratchBefore = f.snapshot(scratch);
        const impl = await f.implementation(
          mutant && !["revision", "fence"].includes(kind)
            ? variant === "migration"
              ? "migration"
              : kind
            : undefined,
        );
        const manifest = {
          ...source.manifest,
          records: kind === "count" ? 7366 : source.manifest.records,
        };
        let projected: ReturnType<typeof impl.currentState> | undefined;
        const reply = f.result(() => {
          projected = impl.currentState(
            source.db,
            scratch,
            manifest,
            kind === "caps"
              ? {
                  ...limits,
                  ...(variant === "rows" ? { maxRows: 1 } : { maxBytes: 1 }),
                }
              : limits,
          );
          if (kind === "revision" || kind === "fence") return null;
          return projected;
        });
        if (kind === "revision" || kind === "fence") {
          eq(status(reply), ["OK", 0, null]);
          if (kind === "revision") {
            scratch.run(
              "UPDATE state_records SET revision=7,body=json_set(body,'$.revision',7) WHERE key='issue:work-1'",
            );
            scratch.run(
              "UPDATE state_events SET body=json_set(body,'$.revision',7) WHERE key='issue:work-1'",
            );
          }
          const target = f.database(),
            targetOwner = f.owner(target);
          targetOwner.initialize([domain]);
          const restore = await f.replay(mutant && kind === "revision");
          const restored = f.result(() => {
            for (const page of impl.pagesOf(scratch, limits))
              restore.restorePage(target, targetOwner, page, limits);
          });
          if (kind === "revision")
            eq(
              status(restored),
              mutant ? ["OK", 0, null] : [expectedStatus, exit, code],
            );
          else {
            eq(status(restored), ["OK", 0, null]);
            const held = await f.fencedOwner(target, mutant),
              saved = f.snapshot(target);
            const fenced = f.result(() =>
              held.put(f.ns, "issue:work-1", { stale: true }, f.actor, {
                expectRevision: 1,
                fence: {
                  subject: "issue:work-1",
                  holder: f.holder,
                  generation: 1,
                },
              }),
            );
            eq(
              status(fenced),
              mutant ? ["OK", 0, null] : [expectedStatus, exit, code],
            );
            if (!mutant) eq(f.snapshot(target), saved);
            eq(target.all("SELECT * FROM state_leases"), []);
          }
        } else if (
          mutant &&
          ["consistency", "scope", "count", "empty"].includes(kind)
        ) {
          ne(status(reply), [expectedStatus, exit, code]);
        } else {
          eq(status(reply), [expectedStatus, exit, code]);
          if (reply.envelope.ok && projected) {
            if (historical) {
              eq(projected.floors, 3);
              for (const [prefix, number] of [
                ["issue:work-", 12000],
                ["comment:work-1:", 9000],
                ["link:work-1:", 9000],
              ] as const)
                eq(state.get(f.ns, `allocation:${prefix}`)?.value, {
                  prefix,
                  number: mutant ? 0 : number,
                });
            }
            for (const record of impl.workRecords(source.db))
              eq(
                canonicalJson(state.get(f.ns, record.key)?.value),
                canonicalJson(record.value),
              );
            const usage = projected.usage.rows;
            eq(usage.state_records, manifest.records + projected.floors);
            if (kind !== "authority" || !mutant) {
              eq(usage.state_events, manifest.records + projected.floors);
              for (const table of [
                "state_leases",
                "state_requests",
                "domain_cloud_requests",
                "domain_cloud_command_receipts",
              ])
                eq(scratch.all(`SELECT * FROM ${table}`), []);
              for (const row of scratch.all("SELECT body FROM state_events"))
                eq(JSON.parse(String(row.body)).requestId, undefined);
            } else ne(scratch.all("SELECT * FROM state_leases"), []);
            if (!mutant) {
              const target = f.database(),
                targetOwner = f.owner(target);
              targetOwner.initialize([domain]);
              for (const page of impl.pagesOf(scratch, limits))
                restorePage(
                  target,
                  targetOwner,
                  parseDump(JSON.stringify(page)) as Page,
                  limits,
                );
              for (const record of impl.workRecords(scratch))
                eq(targetOwner.get(f.ns, record.key)?.value, record.value);
            }
          } else if (!mutant) eq(f.snapshot(scratch), scratchBefore);
        }
        eq(f.snapshot(source.db), before);
        eq(source.bytes(), digest);
      }
  },
  120_000,
);
