import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { guardFixture, probe } from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const expiry = time + 7_200_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const actor = { kind: "agent", id: "fixture" };
const holder = { actor, session: { id: "fixture" } };
const sha = "0123456789abcdef0123456789abcdef01234567";
const headers = {
  "X-Forge-Owner": "laptop",
  "X-Forge-Owner-Expires": String(expiry),
};

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Reply = { status: number; body: Record<string, unknown> };
const typed = (f: Fixture, call: object) =>
  f.send(`${probe}/command`, call, headers) as Promise<Reply>;
async function project() {
  const f = guardFixture(env);
  expect((await f.send(probe, {})).status).toBe(200);
  return f;
}
const show = {
  op: "issue.show",
  requestId: "show",
  input: { id: "forge-1" },
  context: { actor },
};
const list = {
  op: "issue.list",
  requestId: "list",
  input: {},
  context: { actor },
};
const claim = {
  op: "issue.claim",
  requestId: "claim",
  input: { id: "forge-1", ttlSeconds: 60 },
  context: holder,
};
const release = {
  op: "issue.release",
  requestId: "release",
  input: { id: "forge-1" },
  context: { ...holder, leaseGeneration: 1 },
};

test(
  "cloud create update show list and replay preserve normalized file declarations",
  async () => {
    const f = await project();
    using _db = f.db;
    const create = {
      op: "issue.create",
      requestId: "create",
      input: {
        title: "Files",
        expectedFiles: ["./src//alpha.ts", "src/./beta-?.ts", "**/*.rs"],
      },
      context: { actor },
    };
    const created = await typed(f, create);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      result: {
        id: "forge-1",
        expectedFiles: ["src/alpha.ts", "src/beta-?.ts", "**/*.rs"],
      },
    });
    expect(created.body.result).not.toHaveProperty("actualFiles");
    expect(created.body.result).not.toHaveProperty("filesAt");
    expect((await typed(f, claim)).status).toBe(200);
    const update = {
      op: "issue.update",
      requestId: "update",
      input: {
        id: "forge-1",
        expectRevision: 1,
        expectedFiles: ["src/./delivered.ts", "docs//planned-*.ts"],
        actualFiles: ["src//delivered.ts"],
        filesAt: sha,
      },
      context: { ...holder, leaseGeneration: 1 },
    };
    const updated = await typed(f, update);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      result: {
        expectedFiles: ["src/delivered.ts", "docs/planned-*.ts"],
        actualFiles: ["src/delivered.ts"],
        filesAt: sha,
      },
    });
    expect(await typed(f, update)).toEqual(updated);
    expect(await typed(f, show)).toMatchObject({
      status: 200,
      body: {
        result: {
          expectedFiles: ["src/delivered.ts", "docs/planned-*.ts"],
          actualFiles: ["src/delivered.ts"],
          filesAt: sha,
        },
      },
    });
    const listed = await typed(f, list);
    expect(listed.status).toBe(200);
    expect((listed.body.result as { items: unknown[] }).items[0]).toMatchObject(
      {
        expectedFiles: ["src/delivered.ts", "docs/planned-*.ts"],
        actualFiles: ["src/delivered.ts"],
        filesAt: sha,
      },
    );
  },
  timeout,
);

test(
  "cloud invalid declarations are typed refusals and allocate no issue",
  async () => {
    const f = await project();
    using _db = f.db;
    const long = `src/${"a".repeat(1020)}.ts`;
    const invalid = [
      "/src/a.ts",
      "C:/src/a.ts",
      "../a.ts",
      "src/../a.ts",
      "src\a.ts",
      "!src/a.ts",
      "src/[ab].ts",
      "src/{a,b}.ts",
      "src/*(a).ts",
      "",
      long,
    ];
    for (const [index, pattern] of invalid.entries()) {
      const got = await typed(f, {
        op: "issue.create",
        requestId: `invalid-${index}`,
        input: { title: "Invalid", expectedFiles: [pattern] },
        context: { actor },
      });
      expect([index, got.status]).toEqual([index, 400]);
      expect(got.body.error).toMatchObject({ code: "INPUT_INVALID" });
    }
    for (const [index, expectedFiles] of [
      Array.from({ length: 257 }, (_, i) => [`src/${i}.ts`]),
      [5],
    ].entries()) {
      const got = await typed(f, {
        op: "issue.create",
        requestId: `invalid-shape-${index}`,
        input: { title: "Invalid", expectedFiles },
        context: { actor },
      });
      expect(got.status).toBe(400);
      expect(got.body.error).toMatchObject({ code: "INPUT_INVALID" });
    }
    const valid = await typed(f, {
      op: "issue.create",
      requestId: "valid",
      input: { title: "Valid", expectedFiles: [] },
      context: { actor },
    });
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
    const f = await project();
    using _db = f.db;
    expect(
      (
        await typed(f, {
          op: "issue.create",
          requestId: "create",
          input: { title: "Files", expectedFiles: ["src/alpha.ts"] },
          context: { actor },
        })
      ).status,
    ).toBe(200);
    expect((await typed(f, claim)).status).toBe(200);
    const before = await typed(f, show);
    const stale = await typed(f, {
      op: "issue.update",
      requestId: "stale",
      input: {
        id: "forge-1",
        expectRevision: 2,
        expectedFiles: ["src/beta.ts"],
      },
      context: { ...holder, leaseGeneration: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await typed(f, show)).toEqual(before);
    for (const [index, patch] of [
      { expectedFiles: ["src/[ab].ts"] },
      { actualFiles: Array.from({ length: 1025 }, (_, i) => `src/${i}.ts`) },
      { actualFiles: ["src/../outside.ts"] },
      { filesAt: "not-a-sha" },
    ].entries()) {
      const got = await typed(f, {
        op: "issue.update",
        requestId: `invalid-${index}`,
        input: { id: "forge-1", expectRevision: 1, ...patch },
        context: { ...holder, leaseGeneration: 1 },
      });
      expect([index, got.status]).toEqual([index, 400]);
      expect(got.body.error).toMatchObject({ code: "INPUT_INVALID" });
      expect(await typed(f, show)).toEqual(before);
    }
    expect((await typed(f, release)).status).toBe(200);
    const lost = await typed(f, {
      op: "issue.update",
      requestId: "lost",
      input: {
        id: "forge-1",
        expectRevision: 1,
        expectedFiles: ["src/beta.ts"],
      },
      context: { ...holder, leaseGeneration: 1 },
    });
    expect(lost.status).toBe(409);
    expect(["LEASE_NOT_HELD", "LEASE_STALE", "LEASE_EXPIRED"]).toContain(
      (lost.body.error as { code: string }).code,
    );
    expect(await typed(f, show)).toEqual(before);
  },
  timeout,
);
