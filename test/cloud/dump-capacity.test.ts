import { test } from "bun:test";
import { deepStrictEqual as eq, notStrictEqual as ne } from "node:assert";
import * as capacity from "./dump-capacity.fixture.ts";
const { fixture, caps, pages, projection } = capacity;
type Fixture = capacity.Fixture;
import { limitsFrom, DUMP_FORMAT } from "../../cloud/src/dump.ts";
import { TABLES } from "../../cloud/conformance/digest.ts";

const rows = [
  ["Config reaches both directions", "config", 0],
  ["Below warning", "bytes", 23_488_102],
  ["CF row warning", "row", 14_000],
  ["CF byte warning", "byte", 23_488_103],
  ["Per-table rows", "per-table", 10_000],
  ["CF export cap", "export", 20_001],
  ["CF restore cap", "restore", 20_001],
  ["Above-cap diagnostic", "above", 20_001],
  ["Uninitialized status", "empty", 0],
  ["Unreadable initialized status", "unreadable", 0],
  ["CF busy export", "busy", 20],
  ["CF admin boundary", "admin", 0],
] as const;
async function checked(
  f: Fixture,
  route: string,
  code: string | null = null,
  body?: unknown,
) {
  const before = f.snapshot(),
    reply = await f.send(route, body);
  eq(projection(reply), code ? ["FAIL", 1, code] : ["OK", 0, null]);
  eq(f.snapshot(), before);
  return reply.value;
}
test.each(rows)(
  "%s",
  async (_name, kind, n) => {
    const warning = kind === "row" || kind === "byte";
    for (const mutant of warning ||
    ["export", "restore", "busy", "admin"].includes(kind)
      ? [false, true]
      : [false]) {
      const mutation = mutant ? (kind as capacity.Mutation) : undefined;
      const f = await fixture(mutation, kind !== "empty");
      if (kind === "config") {
        eq(Object.values(limitsFrom({})), [4_194_304, 33_554_432, 20_000]);
        eq(DUMP_FORMAT, "forge-cloud-dump/2");
        for (const resource of ["rows", "bytes"]) {
          const source = await fixture();
          if (resource === "rows") source.seed("state_events", 20_000);
          else source.pad(33_554_432);
          const before = source.snapshot(),
            target = await fixture(undefined, false);
          const status = await checked(source, "status");
          eq(Object.values(status.dump.limits), [20_000, 33_554_432]);
          await pages(source, async (page) => {
            eq(projection(await target.send("restore", page)), ["OK", 0, null]);
          });
          eq(source.snapshot(), before);
          eq(target.usage(), source.usage());
          eq(target.values.has("provisioned"), false);
        }
      } else if (
        ["bytes", "row", "byte", "per-table", "above"].includes(kind)
      ) {
        if (kind === "bytes" || kind === "byte") f.pad(n);
        else {
          f.seed("domain_cloud_command_receipts", n);
          if (kind === "per-table") f.seed("state_leases", n);
        }
        const status = await checked(f, "status"),
          usage = f.usage();
        eq(status.dump.rows, usage.rows);
        eq(status.dump.bytes, usage.bytes);
        const resource =
          kind === "byte" ? "bytes" : "domain_cloud_command_receipts";
        const required = warning || kind === "above";
        const cap = kind === "byte" ? 33_554_432 : 20_000;
        const expected = ["DUMP_CAPACITY", resource, n, cap];
        eq(
          status.dump.warnings.map(Object.values),
          required && !mutant ? [expected] : [],
        );
        if (kind === "above")
          await checked(f, "dump?cursor=start", "DUMP_TOO_LARGE");
        else await pages(f);
      } else if (kind === "export") {
        f.seed("state_events", n);
        const mark = f.db
          .query("SELECT epoch, revision FROM domain_cloud_export")
          .get() as { epoch: string; revision: number };
        const w = `${mark.epoch}.${String(mark.revision).padStart(19, "0")}`;
        const cursor = JSON.stringify({ p: 1, t: 0, k: null, w });
        for (const c of ["start", cursor])
          await checked(
            f,
            `dump?cursor=${encodeURIComponent(c)}`,
            mutant ? null : "DUMP_TOO_LARGE",
          );
      } else if (kind === "restore") {
        for (const resource of ["rows", "bytes"]) {
          const source = await fixture("export"),
            target = await fixture(mutation, false);
          if (resource === "rows") source.seed("state_events", n);
          else source.pad(33_554_433);
          const before = source.snapshot(),
            protectedTarget = f.snapshot();
          // Remove the source export cap solely to produce real transport pages above the restore cap.
          let reply: Awaited<ReturnType<Fixture["send"]>> | undefined;
          await pages(source, async (payload) => {
            if (reply && !reply.ok) return;
            await checked(f, "restore", "RESTORE_TARGET_NOT_EMPTY", payload);
            reply = await target.send("restore", payload);
          });
          eq(
            projection(reply!),
            mutant ? ["OK", 0, null] : ["FAIL", 1, "RESTORE_TOO_LARGE"],
          );
          eq(target.values.has("provisioned"), false);
          eq(
            Object.values(target.usage().rows).every((v) => v === 0),
            !mutant,
          );
          eq(source.snapshot(), before);
          eq(f.snapshot(), protectedTarget);
        }
      } else if (kind === "empty") {
        const value = await checked(f, "status");
        eq(value.initialized, false);
        eq(value.dump.bytes, 0);
        const zero = Object.fromEntries(TABLES.map((t) => [t, 0]));
        eq(value.dump.rows, zero);
      } else if (kind === "unreadable") {
        f.unreadable();
        await checked(f, "status", "UNAVAILABLE");
      } else if (kind === "busy") {
        for (const table of [
          "state_records",
          "domain_cloud_command_receipts",
        ] as const) {
          const busy = await fixture(mutation, true, {
            ...caps,
            DUMP_PAGE_BYTES: "1024",
          });
          busy.seed("state_records", n);
          const first = await busy.send("dump?cursor=start");
          const next = first.value.next!;
          ne(next, null);
          if (table === "state_records")
            busy.db.run(
              "UPDATE state_records SET body='{} ' WHERE key='000001'",
            );
          else busy.seed(table, 1);
          await checked(
            busy,
            `dump?cursor=${encodeURIComponent(next)}`,
            mutant ? null : "DUMP_CHANGED",
          );
        }
      } else if (kind === "admin") {
        for (const route of ["status", "dump", "restore"]) {
          const before = f.snapshot(),
            { reply, touched } = await f.admin(
              route,
              route === "restore" ? {} : undefined,
            );
          eq(touched, mutant ? 1 : 0);
          if (mutant) ne(reply.error?.code, "AUTH_INVALID");
          else eq(projection(reply), ["FAIL", 1, "AUTH_INVALID"]);
          eq(f.snapshot(), before);
        }
      }
    }
  },
  30_000,
);
