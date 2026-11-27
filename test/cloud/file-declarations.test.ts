import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runCommand, type CommandRun } from "../../cloud/src/issue-commands.ts";
import { domain } from "../../cloud/src/project.ts";
import type { DurableStorage } from "../../cloud/src/store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const actor = { kind: "agent", id: "fixture" } as const;
const session = { id: "fixture" } as const;
const leased = { actor, session, leaseGeneration: 1 };
const sha = "0123456789abcdef0123456789abcdef01234567";
const full = Array.from({ length: 1024 }, (_, index) => `src/${index}.ts`);
const longFiles = Array.from({ length: 1024 }, () => `src/${"a".repeat(993)}`);

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

type Reply = {
  status: number;
  body: {
    result?: Record<string, unknown>;
    error?: { code: string };
  };
};
const sqlOf = (db: Database): SqlDatabase => ({
  exec: (sql) => {
    db.run(sql);
  },
  run: (sql, params = []) => db.query(sql).run(...(params as never[])),
  all: (sql, params = []) =>
    db.query(sql).all(...(params as never[])) as SqlRow[],
  get: (sql, params = []) =>
    (db.query(sql).get(...(params as never[])) ?? undefined) as
      SqlRow | undefined,
  transaction: (body) => db.transaction(body)(),
});

function project() {
  const raw = new Database(":memory:");
  raw.run(
    "CREATE TABLE domain_cloud_pragma (name TEXT PRIMARY KEY, value INTEGER NOT NULL)",
  );
  const db = sqlOf(raw);
  const owner = new StateOwner(db, { now: () => time });
  owner.initialize([domain]);
  const storage: DurableStorage = {
    sql: {
      exec: (sql, ...bindings) => ({
        toArray: () =>
          raw
            .query(sql)
            .all(
              ...bindings.map((value) =>
                value instanceof ArrayBuffer ? new Uint8Array(value) : value,
              ),
            ) as Record<string, unknown>[],
      }),
    },
    transactionSync: (body) => raw.transaction(body)(),
    get: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
  };
  const host: CommandRun = {
    device: "laptop",
    project: "p",
    session: session.id,
    principal: ["token", "fixture", "laptop"],
    storage,
    idPrefix: "forge",
    now: time,
    recheck: () => {},
    expiresAt: time + 86_400_000,
    open: () => ({ db, owner }),
  };
  const command = async (call: object): Promise<Reply> => {
    try {
      const response = await runCommand(JSON.stringify(call), host);
      return {
        status: response.status,
        body: (await response.json()) as Reply["body"],
      };
    } catch (error) {
      if (!(error instanceof ForgeFailure)) throw error;
      return {
        status: error.error.code === "INPUT_INVALID" ? 400 : 409,
        body: { error: error.error },
      };
    }
  };
  return { db: raw, command };
}

const show = {
  op: "issue.show",
  requestId: "show",
  input: { id: "forge-1" },
  context: { actor },
};
const claim = {
  op: "issue.claim",
  requestId: "claim",
  input: { id: "forge-1", ttlSeconds: 60 },
  context: { actor, session },
};
const create = (requestId: string, input: object) => ({
  op: "issue.create",
  requestId,
  input,
  context: { actor },
});
const update = (requestId: string, patch: object, revision = 1) => ({
  op: "issue.update",
  requestId,
  input: { id: "forge-1", expectRevision: revision, ...patch },
  context: leased,
});

const inputInvalid = (got: Reply) =>
  expect([got.status, got.body.error?.code]).toEqual([400, "INPUT_INVALID"]);

test(
  "cloud create update show list and replay preserve normalized file declarations",
  async () => {
    const f = project();
    using _db = f.db;
    const created = await f.command(
      create("create", {
        title: "Files",
        expectedFiles: ["./src//alpha.ts", "src/./beta-?.ts", "**/*.rs"],
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      result: {
        id: "forge-1",
        expectedFiles: ["src/alpha.ts", "src/beta-?.ts", "**/*.rs"],
      },
    });
    expect(created.body.result).not.toHaveProperty("actualFiles");
    expect(created.body.result).not.toHaveProperty("filesAt");
    expect((await f.command(claim)).status).toBe(200);
    const edit = update("update", {
      expectedFiles: ["src/./delivered.ts", "docs//planned-*.ts"],
      actualFiles: full,
      filesAt: sha,
    });
    const updated = await f.command(edit);
    expect(updated.status).toBe(200);
    const wanted = {
      expectedFiles: ["src/delivered.ts", "docs/planned-*.ts"],
      actualFiles: full,
      filesAt: sha,
    };
    expect(updated.body).toMatchObject({ result: wanted });
    expect((await f.command(edit)).body).toEqual(updated.body);
    expect(await f.command(show)).toMatchObject({
      status: 200,
      body: { result: wanted },
    });
    const listed = await f.command({
      op: "issue.list",
      requestId: "list",
      input: {},
      context: { actor },
    });
    expect(listed.status).toBe(200);
    expect((listed.body.result as { items: unknown[] }).items[0]).toMatchObject(
      wanted,
    );
  },
  timeout,
);

test(
  "cloud invalid declarations are typed refusals and allocate no issue",
  async () => {
    const f = project();
    using _db = f.db;
    const invalid = [
      "/src/a.ts",
      "C:/src/a.ts",
      "./C:/outside.ts",
      "../a.ts",
      "src\a.ts",
      "!src/a.ts",
      "src/[ab].ts",
      `src/${"a".repeat(1020)}.ts`,
    ];
    for (const [index, pattern] of invalid.entries()) {
      const got = await f.command(
        create(`invalid-${index}`, {
          title: "Invalid",
          expectedFiles: [pattern],
        }),
      );
      inputInvalid(got);
    }
    const oversized = await f.command(
      create("invalid-oversized", {
        title: "Invalid",
        expectedFiles: Array.from({ length: 257 }, (_, i) => `src/${i}.ts`),
      }),
    );
    inputInvalid(oversized);
    const valid = await f.command(
      create("valid", { title: "Valid", expectedFiles: [] }),
    );
    expect(valid.status).toBe(200);
    expect(valid.body.result).toMatchObject({
      id: "forge-1",
      expectedFiles: [],
    });
  },
  timeout,
);

test(
  "cloud file declaration updates keep the revision and lease fence",
  async () => {
    const f = project();
    using _db = f.db;
    expect(
      (
        await f.command(
          create("create", {
            title: "Files",
            body: "b".repeat(65536),
            expectedFiles: ["src/alpha.ts"],
          }),
        )
      ).status,
    ).toBe(200);
    expect((await f.command(claim)).status).toBe(200);
    const before = await f.command(show);
    const stale = await f.command(
      update("stale", { expectedFiles: ["src/beta.ts"] }, 2),
    );
    expect([stale.status, stale.body.error?.code]).toEqual([
      409,
      "REVISION_CONFLICT",
    ]);
    expect(await f.command(show)).toEqual(before);
    for (const [index, patch] of [
      { expectedFiles: ["src/[ab].ts"] },
      { actualFiles: Array.from({ length: 1025 }, (_, i) => `src/${i}.ts`) },
      { actualFiles: ["src/../outside.ts", "./D:/outside.ts"] },
      { filesAt: "not-a-sha" },
    ].entries()) {
      const got = await f.command(update(`invalid-${index}`, patch));
      inputInvalid(got);
      expect(await f.command(show)).toEqual(before);
    }
    const large = await f.command(update("large", { actualFiles: longFiles }));
    expect([large.status, large.body.error?.code]).toEqual([
      409,
      "UNAVAILABLE",
    ]);
    expect(await f.command(show)).toEqual(before);
    expect(
      (
        await f.command({
          op: "issue.release",
          requestId: "release",
          input: { id: "forge-1" },
          context: leased,
        })
      ).status,
    ).toBe(200);
    const lost = await f.command(
      update("lost", { expectedFiles: ["src/beta.ts"] }),
    );
    expect(lost.status).toBe(409);
    expect(["LEASE_NOT_HELD", "LEASE_STALE", "LEASE_EXPIRED"]).toContain(
      lost.body.error!.code,
    );
    expect(await f.command(show)).toEqual(before);
  },
  timeout,
);
