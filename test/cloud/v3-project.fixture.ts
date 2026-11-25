import { createHmac, randomBytes } from "node:crypto";
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import type { ForgeError, ResultEnvelope } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { archivedCheck } from "../../cloud/src/v3-checkpoint.ts";
import { recoverV3, unavailable } from "../../cloud/src/v3-store.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
} from "../../src/core/config/pointer.ts";
import { type DurableState, writableStore } from "../../cloud/src/store.ts";
import {
  authenticateManifest,
  type Manifest,
  type Seal,
  sealOf,
  signRoot,
  signRow,
} from "../../cloud/src/v3-seal.ts";
import { browserStorage } from "./browser-storage.fixture.ts";

export const probe = "test-v3";
export const sqlMutation =
  /^\s*(ALTER|CREATE|DELETE|DROP|INSERT|REPLACE|UPDATE)\b/i;
export const noWrites = {
  sqlWriteAttempts: 0,
  alarmWrites: 0,
  sqlAndKvIntact: true,
};

const sealers = new WeakMap<Database, () => Seal>();
export const trustedSeal = (db: Database, body: string) =>
  signRoot(sealers.get(db)!(), body);

export const trustedManifest = (
  { keys: [key] }: Seal,
  manifest: Omit<Manifest, "mac">,
): Manifest => ({
  ...manifest,
  mac: `${key.id}.${createHmac("sha256", key.bytes)
    .update(canonicalJson(["forge/v3/manifest/1", manifest]))
    .digest("hex")}`,
});

export function verifiedPortable(seal: Seal, transcript: string) {
  const member = (id: string, body: string) => ({
    id,
    bytes: Buffer.byteLength(body),
    hash: digestBytes(body),
  });
  const manifest = trustedManifest(seal, {
    format: "forge-cloud-portable/4",
    head: 0,
    eventWatermark: 0,
    recordFloor: 0,
    publicDigest: digestBytes("[]"),
    pages: [
      member("directory:0", "[]"),
      member("snapshot:0", ""),
      member("transcript:0", transcript),
    ],
    source: "direct-fold-source",
  });
  return authenticateManifest(seal, manifest, digestValue(manifest))!;
}

export type Portable = ReturnType<typeof portableOf>;
export function portableOf(source: ReturnType<typeof fixture>) {
  const { head, eventWatermark, recordFloor, root } = recovered(
    writableStore(source.storage),
    source.seal(),
  );
  const pages = source.db
    .query<{ id: string; body: string }, []>(
      "SELECT id, body FROM cloud_v3_pages ORDER BY id",
    )
    .all();
  const publicDigest = root.publicDigest as string;
  const id = String(source.context.id);
  return { pages, head, eventWatermark, recordFloor, publicDigest, source: id };
}

export function portableUpload(
  target: ReturnType<typeof fixture>,
  { pages, ...projection }: Portable,
) {
  const manifest = trustedManifest(target.seal(), {
    ...projection,
    format: "forge-cloud-portable/4",
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
  });
  const digest = digestBytes(canonicalJson(manifest));
  const headers = (page: number) =>
    page === 0 ? { "X-Forge-Manifest-Digest": digest } : {};
  return (page: number) =>
    target.send(
      "restore",
      { page, ...pages[page]!, ...(page === 0 && { manifest }) },
      headers(page),
    );
}

export const recovered = (db: SqlDatabase, seal: Seal) =>
  recoverV3(
    db,
    seal,
    archivedCheck(db, {
      admit: Project.admitLeaseRequest,
      failure: unavailable,
    }),
  );

export interface SealSetup {
  key?: string | null;
  previous?: string;
  id?: string | null;
}
export const newKey = () => randomBytes(32).toString("base64url");

export function fixture(
  before?: (sql: string) => void,
  env?: unknown,
  setup: SealSetup = {},
) {
  const {
    key = newKey(),
    previous,
    id = randomBytes(32).toString("hex"),
  } = setup;
  const sealed = {
    ...(env as Record<string, unknown> | undefined),
    ...(key === null ? {} : { V3_SEAL_KEY: key }),
    ...(previous === undefined ? {} : { V3_SEAL_KEY_PREVIOUS: previous }),
  };
  const db = new Database(":memory:");
  const { storage, values } = browserStorage(db, before);
  const reads = { rows: 0, bytes: 0 };
  const exec = storage.sql.exec.bind(storage.sql);
  storage.sql.exec = (statement, ...bindings) => {
    const rows = exec(statement, ...bindings).toArray();
    reads.rows += rows.length;
    for (const value of rows.flatMap((row) => Object.values(row)))
      reads.bytes +=
        typeof value === "string"
          ? Buffer.byteLength(value)
          : value instanceof Uint8Array
            ? value.byteLength
            : typeof value === "number"
              ? 8
              : 0;
    return { toArray: () => rows };
  };
  const alarms: number[] = [];
  storage.getAlarm = () => Promise.resolve(alarms.at(-1) ?? null);
  storage.setAlarm = (time) => {
    alarms.push(time);
    return Promise.resolve();
  };
  const context: DurableState = {
    storage,
    testV3: true,
    ...(id === null ? {} : { id: { toString: () => id } }),
  };
  let project = new Project(context, sealed);
  const seal = () => sealOf(sealed, context.id);
  sealers.set(db, seal);
  const sign = (sequence: number, body: string) =>
    signRow(
      seal(),
      (
        JSON.parse(
          db
            .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
            .get()!.body,
        ) as { incarnation: string }
      ).incarnation,
      sequence,
      body,
    );
  const request = (
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(`https://fixture.example/p/a/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    db,
    storage,
    values,
    reads,
    alarms,
    alarm: () => project.alarm(),
    request,
    fetch: (incoming: Request) => project.fetch(incoming),
    env: sealed,
    context,
    seal,
    sign,
    restart: (testV3 = true) => {
      project = new Project(testV3 ? context : { storage }, sealed);
    },
    send: async (
      route: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      const response = await project.fetch(request(route, body, headers));
      return {
        status: response.status,
        body: await response.json(),
      };
    },
    sendText: async (
      route: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      const response = await project.fetch(request(route, body, headers));
      return { status: response.status, text: await response.text() };
    },
    snapshot: () => ({ sql: db.serialize(), kv: [...values] }),
  };
}

export function guardFixture(env?: unknown, setup?: SealSetup) {
  let sqlWriteAttempts = 0;
  const f = fixture(
    (sql) => {
      if (sqlMutation.test(sql)) sqlWriteAttempts++;
    },
    env,
    setup,
  );
  return {
    ...f,
    observeEffects() {
      const before = f.snapshot();
      const priorAlarmWrites = f.alarms.length;
      sqlWriteAttempts = 0;
      return () => {
        const after = f.snapshot();
        return {
          sqlWriteAttempts,
          alarmWrites: f.alarms.length - priorAlarmWrites,
          sqlAndKvIntact:
            Buffer.from(before.sql).equals(after.sql) &&
            JSON.stringify(before.kv) === JSON.stringify(after.kv),
        };
      };
    },
  };
}

export function observeRestoreReset(target: ReturnType<typeof guardFixture>) {
  const { db, values } = target;
  const catalog = db.query<{ type: string; name: string }, []>(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name <> 'cloud_v3_restore' ORDER BY type, name",
  );
  const state = () => {
    const schema = catalog.all();
    const rows = schema
      .filter(({ type }) => type === "table")
      .map(({ name }) =>
        db.query('SELECT * FROM "' + name.replaceAll('"', '""') + '"').values(),
      );
    return { schema, rows, kv: structuredClone([...values]) };
  };
  const before = state();
  const effects = target.observeEffects();
  return () => {
    expect(
      db
        .query("SELECT name FROM sqlite_schema WHERE name='cloud_v3_restore'")
        .all(),
    ).toEqual([]);
    expect(effects()).toEqual({
      ...noWrites,
      sqlWriteAttempts: 2,
      sqlAndKvIntact: false,
    });
    expect(state()).toEqual(before);
  };
}

type RawReply = { status: number; text: string };

export async function readOnlyReply(
  f: ReturnType<typeof guardFixture>,
  send: () => Promise<RawReply>,
) {
  const observed = f.observeEffects();
  const reply = await send();
  expect(observed()).toEqual(noWrites);
  return reply;
}

type ExpectedReply = { status: number; exit: number } & (
  | { op: string; result: object; omits?: readonly string[] }
  | { error: ForgeError }
);

export function expectTypedReply(
  reply: RawReply,
  expected: ExpectedReply,
  mode: "owner" | "token" = "owner",
) {
  const body = JSON.parse(reply.text) as
    ResultEnvelope | { ok: false; error: ForgeError };
  expect(reply.status).toBe(expected.status);
  expect(body).toEqual(
    "error" in expected
      ? mode === "owner"
        ? { ok: false, error: expected.error }
        : { ok: false, status: "FAIL", error: expected.error, warnings: [] }
      : {
          ok: true,
          status: "OK",
          op: expected.op,
          result: expected.result,
          warnings: [],
        },
  );
  expect(
    exitCode(
      "status" in body ? body : { ...body, status: "FAIL", warnings: [] },
    ),
  ).toBe(expected.exit);
  if (body.ok && "result" in expected)
    for (const key of expected.omits ?? [])
      expect(Object.hasOwn(body.result as object, key)).toBe(false);
}

export const changedCommandReply = {
  status: 409,
  exit: 4,
  error: {
    code: "INPUT_CONFLICT",
    message: "Request ID belongs to a different input",
    retry: "reconcile_first",
  },
} satisfies ExpectedReply;

type TypedCall = {
  op: string;
  requestId: string;
  input: object;
  context: object;
};

export function typedReplyCases(time: number, device: string) {
  const actor = { kind: "agent", id: "fixture" } as const;
  const session = { id: "fixture" };
  const create = {
    op: "issue.create",
    requestId: "create",
    input: { title: "Before" },
    context: { actor },
  };
  const createWithFields = {
    ...create,
    requestId: "create-with-fields",
    input: {
      title: "Another",
      body: "Details",
      kind: "bug",
      labels: ["cloud"],
    },
  };
  const claim = {
    op: "issue.claim",
    requestId: "claim",
    input: { id: "forge-1", ttlSeconds: 60 },
    context: { actor, session },
  };
  const update = {
    op: "issue.update",
    requestId: "update",
    input: { id: "forge-1", expectRevision: 1, title: "After" },
    context: { actor, session, leaseGeneration: 1 },
  };
  const accepted = <T extends object>(
    call: TypedCall,
    result: T,
    omits?: readonly string[],
  ) => ({
    call,
    expected: {
      status: 200,
      exit: 0,
      op: call.op,
      result,
      ...(omits && { omits }),
    },
  });
  const timestamp = new Date(time).toISOString();
  const created = {
    id: "forge-1",
    title: "Before",
    status: "open",
    labels: [],
    dependsOn: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
  const grant = {
    id: "forge-1",
    generation: 1,
    expiresAt: new Date(time + 60_000).toISOString(),
  };
  const lease = {
    subject: "issue:work-1",
    holder: { actor, session: { id: "fixture", device } },
    generation: 1,
    expiresAt: grant.expiresAt,
  };
  return {
    create: accepted(create, created, ["body", "kind", "parent", "lease"]),
    createWithFields: accepted(createWithFields, {
      ...created,
      id: "forge-2",
      title: "Another",
      body: "Details",
      kind: "bug",
      labels: ["cloud"],
    }),
    claim: accepted(claim, grant),
    update: accepted(update, {
      ...created,
      title: "After",
      revision: 2,
      lease,
    }),
    missing: {
      call: {
        ...update,
        requestId: "missing",
        input: { ...update.input, id: "forge-9" },
      },
      expected: {
        status: 404,
        exit: 3,
        error: {
          code: "NOT_FOUND",
          message: "Issue was not found",
          retry: "never",
        },
      } satisfies ExpectedReply,
    },
    revisionConflict: {
      call: { ...update, requestId: "old-revision" },
      expected: {
        status: 409,
        exit: 4,
        error: {
          code: "REVISION_CONFLICT",
          message: "Expected revision 1; current revision is 2",
          retry: "reconcile_first",
          currentRevision: 2,
        },
      } satisfies ExpectedReply,
    },
  };
}

export function copyTables(from: { db: Database }, to: { db: Database }) {
  for (const table of ["cloud_v3_commits", "cloud_v3_pages", "cloud_v3_root"]) {
    to.db.run(`DELETE FROM ${table}`);
    for (const row of from.db
      .query<Record<string, string | number>, []>(`SELECT * FROM ${table}`)
      .all()) {
      const names = Object.keys(row);
      to.db.run(
        `INSERT INTO ${table} (${names.join()}) VALUES (${names.map(() => "?").join()})`,
        Object.values(row),
      );
    }
  }
}
