import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import type { Page } from "../../cloud/src/dump.ts";
import type { ForgeError } from "../../src/generated/types.ts";
if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
interface Reply {
  ok: boolean;
  error: ForgeError;
  value: Page & {
    initialized: boolean;
    dump: {
      rows: Record<string, number>;
      bytes: number;
      limits: { maxRows: number; maxBytes: number };
      warnings: Record<string, string | number>[];
    };
  };
}
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { COLUMNS, TABLES, type Table } from "../../cloud/conformance/digest.ts";
import { success } from "../../src/surface/dispatch.ts";
import { exitCode, failure } from "../../src/surface/result.ts";
import { browserStorage } from "./browser-storage.fixture.ts";
export const caps = { DUMP_MAX_ROWS: "20000", DUMP_MAX_BYTES: "33554432" };
const databases: Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
export type Mutation = "row" | "byte" | "export" | "restore" | "busy" | "admin";
const mutations: Record<Mutation, [string, string]> = {
  row: ["used >= Math.ceil(limits.maxRows * 0.7)", "false"],
  byte: ["bytes >= Math.ceil(limits.maxBytes * 0.7)", "false"],
  export: ['assertLimits(db, limits, "DUMP_TOO_LARGE", "The project");', ""],
  restore: [
    'assertLimits(db, limits, "RESTORE_TOO_LARGE", "The staged restore");',
    "",
  ],
  busy: ["from.p !== 0 && from.w !== now", "false"],
  admin: ["ADMIN_ROUTES.has(match![2]!) &&", "false &&"],
};
// Transpile actual source, replacing exactly one guard; dependencies retain their normal identities.
async function moduleUrl(
  file: string,
  change?: [string, string],
  dump?: string,
) {
  const url = new URL(`../../cloud/src/${file}.ts`, import.meta.url);
  let source = await Bun.file(url).text();
  if (change) {
    assert.equal(source.split(change[0]).length, 2);
    source = source.replace(...change);
  }
  source = source.replace(
    /from "(\.\.?\/[^"]+)"/g,
    (_all, spec: string) =>
      `from "${spec === "./dump.ts" && dump ? dump : new URL(spec, url).href}"`,
  );
  return `data:text/javascript;base64,${Buffer.from(new Bun.Transpiler({ loader: "ts" }).transformSync(source)).toString("base64")}`;
}
export async function fixture(
  mutation?: Mutation,
  initialized = true,
  env: Record<string, string> = caps,
) {
  const db = new Database(":memory:");
  databases.push(db);
  let unreadable = false;
  const { storage, values } = browserStorage(db, (sql) => {
    if (unreadable && sql.includes("COUNT(*) AS n"))
      throw new Error("injected usage read failure");
  });
  const dump =
    mutation && mutation !== "admin"
      ? await moduleUrl("dump", mutations[mutation])
      : undefined;
  const Impl: typeof Project = dump
    ? (
        (await import(await moduleUrl("project", undefined, dump))) as {
          Project: typeof Project;
        }
      ).Project
    : Project;
  let project = new Impl({ storage }, env);
  const request = (route: string, body?: unknown, token = "admin-fixture") =>
    new Request(`https://fixture.example/p/a/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const send = async (route: string, body?: unknown) =>
    project.fetch(request(route, body)).then((r) => r.json() as Promise<Reply>);
  if (initialized) {
    const issued = await send("devices", { device: "phone", ttlMs: 172800000 });
    assert.equal(issued.ok, true);
    project = new Impl({ storage }, env);
  }
  const worker: typeof createWorker =
    mutation === "admin"
      ? (
          (await import(await moduleUrl("worker", mutations.admin))) as {
            createWorker: typeof createWorker;
          }
        ).createWorker
      : createWorker;
  const seed = (table: Table, n: number) => {
    const id = "printf('%06d', i)";
    const fields: Record<Table, string> = {
      state_records: `'fixture',${id},1,'{}'`,
      state_events: `i,'fixture',${id},'{}'`,
      state_leases: `'fixture',${id},1,'{}'`,
      state_requests: `'fixture',${id},'{}','{}'`,
      domain_cloud_requests: `${id},'{}','INPUT_INVALID','{}'`,
      domain_cloud_command_receipts: `${id},'{}','INPUT_INVALID','{}',0,1`,
    };
    db.run(
      `WITH RECURSIVE rows(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM rows WHERE i<${n}) INSERT INTO ${table} (${COLUMNS[table].join(",")}) SELECT ${fields[table]} FROM rows`,
    );
  };
  const usage = () => {
    const rows: Record<string, number> = {};
    let bytes = 0;
    for (const t of TABLES) {
      rows[t] = 0;
      for (const row of db
        .query(`SELECT ${COLUMNS[t].join(",")} FROM ${t}`)
        .iterate() as Iterable<Record<string, string | number>>) {
        rows[t]++;
        for (const c of COLUMNS[t]) bytes += Buffer.byteLength(String(row[c]));
      }
    }
    return { rows, bytes };
  };
  const pad = (bytes: number) => {
    seed("state_records", 32);
    db.run(`UPDATE state_records SET body='{"pad":"é"}'`);
    let left = bytes - usage().bytes;
    for (const { key } of db
      .query("SELECT key FROM state_records ORDER BY key")
      .all() as { key: string }[]) {
      const n = Math.min(left, 1_048_576);
      left -= n;
      db.query(
        "UPDATE state_records SET body=json_object('pad','é'||substr(hex(zeroblob(?)),1,?)) WHERE key=?",
      ).run(n, n, key);
    }
    assert.equal(left, 0);
    assert.equal(usage().bytes, bytes);
  };
  const snapshot = () => [
    createHash("sha256").update(db.serialize()).digest("hex"),
    JSON.stringify([...values]),
  ];
  return {
    db,
    values,
    seed,
    pad,
    usage,
    snapshot,
    send,
    unreadable: () => {
      unreadable = true;
    },
    admin: async (route: string, body?: unknown) => {
      let touched = 0;
      const reply = await worker()
        .fetch(request(route, body, "device-fixture"), {
          ADMIN_TOKEN: "admin-fixture",
          PROJECTS: {
            idFromName: (s) => s,
            get: () => {
              touched++;
              return project;
            },
          },
        })
        .then((r) => r.json() as Promise<Reply>);
      return { reply, touched };
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function projection(reply: Pick<Reply, "ok" | "error">) {
  const envelope = reply.ok
    ? success("issue.show", null)
    : failure(reply.error.code, reply.error.message);
  const code = reply.ok ? null : reply.error.code;
  return [envelope.status, exitCode(envelope), code];
}
export async function pages(
  f: Fixture,
  visit: (page: unknown) => Promise<void> = async () => {},
) {
  let cursor: string | null = "start";
  do {
    const reply = await f.send(`dump?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(reply.ok, true);
    await visit({ ...reply.value, last: false, next: "more" });
    cursor = reply.value.next;
  } while (cursor !== null);
}
