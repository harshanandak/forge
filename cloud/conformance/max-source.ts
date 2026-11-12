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
/** Exactly 65,536 code points of U+20AC: three UTF-8 bytes each but one UTF-16 unit, so a byte count and a unit count differ by two per character. */
export const WIDE = "€".repeat(65_536);
/** The fixed clock of the small fixtures, so their rows are the same in every process. */
export const FROZEN = 1_800_000_000_000;
export const TITLE = 'Max "quoted" \\ é€';
export const ACTOR = { kind: "agent", id: "max-source" } as const;
export const DEVICE = "laptop";

export type Row = Record<string, string | number>;
export type Tables = Record<string, Row[]>;
export const DUMP = "forge-cloud-dump/1";
export const PAGE = "forge-cloud-dump-page/1";
// Each table's columns and primary key, in dump order.
export const SHAPE: Record<string, [string, string]> = {
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

export const call = (requestId: string, op: string, input: object) => ({
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

/**
 * An empty project `name` with its issue prefix, driven through the real Project and read with plain SQL. With `at`,
 * every request sees that fixed clock, so the same commands give the same rows in any process.
 */
async function harness(name: string, prefix: string, at?: number) {
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
  const post = async (route: string, body: object, token?: string) => {
    const real = Date.now;
    if (at !== undefined) Date.now = () => at;
    try {
      return await project.fetch(
        new Request(`https://source.example/p/${name}/${route}`, {
          method: "POST",
          headers:
            token === undefined ? {} : { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
      );
    } finally {
      Date.now = real;
    }
  };
  const issued = (await (
    await post("devices", { device: DEVICE, ttlMs: 3_600_000 })
  ).json()) as { value: { token: string } };
  const send = async (request: object): Promise<Sent> => {
    const response = await post("command", request, issued.value.token);
    return { request, status: response.status, text: await response.text() };
  };
  const claim = (body: object) => post("claim", body, issued.value.token);
  return { db, send, claim };
}
type Harness = Awaited<ReturnType<typeof harness>>;

/** The command is accepted, or the fixture is wrong. */
async function accepted(h: Harness, request: object): Promise<void> {
  const reply = await h.send(request);
  if (reply.status !== 200)
    throw new Error(`fixture command refused: ${reply.text.slice(0, 200)}`);
}

/** The project `name`, with its issue prefix, holding the four calls of maxCalls, read back with plain SQL. */
export async function maxSource(name: string, prefix = "forge", at?: number) {
  const h = await harness(name, prefix, at);
  const calls = maxCalls(`${prefix}-1`);
  const sent = {
    create: await h.send(calls.create),
    comment: await h.send(calls.comment),
    badCreate: await h.send(calls.badCreate),
    badComment: await h.send(calls.badComment),
  };
  const tables = tablesOf(h.db);
  return { ...h, sent, tables, doc: { format: DUMP, tables } };
}

/** One accepted create with a short title, at the fixed clock: a few small rows that are identical in every process. */
export async function tinySource(title: string) {
  const h = await harness("tiny", "forge", FROZEN);
  await accepted(h, call("tiny-create", "issue.create", { title }));
  const tables = tablesOf(h.db);
  h.db.close();
  return { tables, doc: { format: DUMP, tables } };
}

/** One lease on `subject` taken through the claim route, at the fixed clock. */
export async function leaseSource(subject: string) {
  const h = await harness("lease", "forge", FROZEN);
  const reply = await h.claim({
    subject,
    holder: { actor: ACTOR, session: { id: "lease-session" } },
    ttlMs: 600_000,
    requestId: "lease-claim",
  });
  if (reply.status !== 200)
    throw new Error(`fixture claim refused: ${await reply.text()}`);
  const tables = tablesOf(h.db);
  h.db.close();
  return { tables, doc: { format: DUMP, tables } };
}

/** The stored bytes of every column of every row, summed by SQLite the way a restore bounds a project. */
const storedBytes = (db: Database): number =>
  Object.entries(SHAPE).reduce((sum, [table, [columns]]) => {
    const sizes = columns
      .split(", ")
      .map((column) => `LENGTH(CAST(${column} AS BLOB))`)
      .join(" + ");
    const found = db
      .query(`SELECT COALESCE(SUM(${sizes}), 0) AS n FROM ${table}`)
      .get() as { n: number };
    return sum + found.n;
  }, 0);

/**
 * The maxCalls project, three more maximum creates and one create whose ASCII body is `tail` characters long: one
 * project whose accepted commands make up a single page near the restore body. Four rows carry each created body.
 */
export async function nearSource(tail: number) {
  const s = await maxSource("near", "forge", FROZEN);
  for (const n of [1, 2, 3])
    await accepted(
      s,
      call(`near-grow-${n}`, "issue.create", {
        title: `Near ${n}`,
        body: BODY,
      }),
    );
  await accepted(
    s,
    call("near-tail", "issue.create", {
      title: "Near tail",
      body: "x".repeat(tail),
    }),
  );
  const tables = tablesOf(s.db);
  const stored = storedBytes(s.db);
  s.db.close();
  return { tables, stored };
}
