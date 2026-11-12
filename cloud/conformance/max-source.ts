// A project built by real typed commands at the largest legal sizes, shared by the route tests and the
// large conformance phase. Its rows are read back with plain SQL, never through dump export, so a restore
// case reaches the parser even while export is broken. Test code only: the Worker never imports it.
import { Database } from "bun:sqlite";
import { Project } from "../src/project.ts";
import type { DurableStorage } from "../src/store.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

/** Exactly 65,536 code points: a quote, a backslash and two multibyte characters, then U+0001, six JSON characters each. */
export const BODY = '"\\é€' + "\u0001".repeat(65_532);
/** One code point over the schema's body limit. */
export const TOO_LONG = BODY + "\u0001";
export const TITLE = 'Max "quoted" \\ é€';
export const ACTOR = { kind: "agent", id: "max-source" } as const;
export const DEVICE = "laptop";

export type Row = Record<string, string | number>;
export type Tables = Record<string, Row[]>;
export const DUMP = "forge-cloud-dump/1";
export const PAGE = "forge-cloud-dump-page/1";
// Each table's columns and primary key, in dump order.
const SHAPE: Record<string, [string, string]> = {
  state_records: ["namespace, key, revision, body", "namespace, key"],
  state_events: ["sequence, namespace, key, body", "sequence"],
  state_leases: ["namespace, subject, generation, body", "namespace, subject"],
  state_requests: [
    "namespace, request_id, fingerprint, result",
    "namespace, request_id",
  ],
  domain_cloud_requests: [
    "request_id, fingerprint, outcome, result",
    "request_id",
  ],
};

export const tablesOf = (db: Database): Tables =>
  Object.fromEntries(
    Object.entries(SHAPE).map(([table, [columns, keys]]) => [
      table,
      db
        .query(`SELECT ${columns} FROM ${table} ORDER BY ${keys}`)
        .all() as Row[],
    ]),
  );

/** Pages of `per` rows, cut across tables in dump order the way a paged export cuts them. */
export function pagesOf(tables: Tables, per: number) {
  const rows = Object.entries(tables).flatMap(([table, list]) =>
    list.map((row) => ({ table, row })),
  );
  const count = Math.max(1, Math.ceil(rows.length / per));
  return Array.from({ length: count }, (_, page) => {
    const part: Tables = Object.fromEntries(
      Object.keys(SHAPE).map((t) => [t, []]),
    );
    for (const { table, row } of rows.slice(page * per, (page + 1) * per))
      part[table]!.push(row);
    const last = page === count - 1;
    return {
      format: PAGE,
      page,
      last,
      next: last ? null : "more",
      tables: part,
    };
  });
}

export interface Sent {
  request: object;
  status: number;
  text: string;
}

const call = (requestId: string, op: string, input: object) => ({
  requestId,
  op,
  input,
  context: { actor: ACTOR },
});
/** An accepted create and comment at the largest size, then the same two refused one code point over it. */
export const maxCalls = (id: string, body = BODY) => ({
  create: call("max-create", "issue.create", { title: TITLE, body }),
  comment: call("max-comment", "issue.comment", { id, body }),
  badCreate: call("max-bad-create", "issue.create", {
    title: "T",
    body: TOO_LONG,
  }),
  badComment: call("max-bad-comment", "issue.comment", { id, body: TOO_LONG }),
});

/** The project `name`, with its issue prefix, holding the four calls of maxCalls, read back with plain SQL. */
export async function maxSource(name: string, prefix = "forge") {
  const db = new Database(":memory:");
  const values = new Map<string, unknown>();
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => {
        const rows = db
          .query(sql)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync: (body) => db.transaction(body)(),
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
  const project = new Project(
    { storage },
    { FORGE_CLOUD_PROJECT: name, FORGE_CLOUD_ID_PREFIX: prefix },
  );
  const post = (route: string, body: object, token?: string) =>
    project.fetch(
      new Request(`https://source.example/p/${name}/${route}`, {
        method: "POST",
        headers:
          token === undefined ? {} : { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
  const issued = (await (
    await post("devices", { device: DEVICE, ttlMs: 3_600_000 })
  ).json()) as { value: { token: string } };
  const send = async (request: object): Promise<Sent> => {
    const response = await post("command", request, issued.value.token);
    return { request, status: response.status, text: await response.text() };
  };
  const calls = maxCalls(`${prefix}-1`);
  const sent = {
    create: await send(calls.create),
    comment: await send(calls.comment),
    badCreate: await send(calls.badCreate),
    badComment: await send(calls.badComment),
  };
  const tables = tablesOf(db);
  return { db, sent, tables, doc: { format: DUMP, tables } };
}
