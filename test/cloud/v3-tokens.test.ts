import { createHash, createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { guardFixture, probe } from "./v3-project.fixture.ts";

const timeout = 30_000;
const HOUR = 3_600_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const note = { operation: "fixture.note", time: 1, events: [] };

type Fixture = ReturnType<typeof guardFixture>;
interface Stored {
  id: string;
  hash: string;
  device: string;
  session: string | null;
  agent: string | null;
  harness: string | null;
  expires_at: number;
  revoked_at: number | null;
  mac: string;
}

const macOf = (f: Fixture, row: Stored) => {
  const bytes = Buffer.from(String(f.env.V3_SEAL_KEY), "base64url");
  const keyId = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const signed = canonicalJson([
    "forge/v3/token/1",
    f.context.id!.toString(),
    row.id,
    row.hash,
    row.device,
    row.session,
    row.agent,
    row.harness,
    row.expires_at,
    row.revoked_at,
  ]);
  return `${keyId}.${createHmac("sha256", bytes).update(signed).digest("hex")}`;
};

const tokenRows = (f: Fixture) =>
  f.db.query<Stored, []>("SELECT * FROM cloud_v3_tokens ORDER BY id").all();

async function issueAndCheckRow(f: Fixture) {
  const reply = await f.send("devices", {
    device: "laptop",
    session: "run-1",
    ttlMs: HOUR,
  });
  expect(reply.status).toBe(200);
  const value = (
    reply.body as { value: { id: string; token: string; session: string } }
  ).value;
  expect(value.token).toMatch(/^fct_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  expect(value.session).toBe("run-1");
  const secret = value.token.split(".")[1]!;
  const [row, ...others] = tokenRows(f);
  expect(others).toEqual([]);
  expect(row!.id).toBe(value.id);
  expect(row!.hash).toBe(createHash("sha256").update(secret).digest("hex"));
  expect(row!.hash).not.toBe(secret);
  expect(row!.revoked_at).toBeNull();
  expect(row!.mac).toBe(macOf(f, row!));
  for (const key of ["provisioned", "STATE_EPOCH", "restore:next"])
    expect(f.values.has(key)).toBe(false);
}

async function withActivated(run: (target: Fixture) => Promise<void>) {
  const source = guardFixture(env);
  const target = guardFixture(env);
  using _source = source.db;
  using _target = target.db;
  expect((await source.send(probe, {})).status).toBe(200);
  expect(
    (await source.send(`${probe}/commits`, { frames: [note] })).status,
  ).toBe(200);
  expect((await source.send(`${probe}/checkpoint`, {})).status).toBe(200);
  const pages = source.db
    .query<{ id: string; body: string }, []>(
      "SELECT id, body FROM cloud_v3_pages ORDER BY id",
    )
    .all()
    .map((page) =>
      page.id === "transcript:0"
        ? { ...page, body: canonicalJson([{ sequence: 1 }]) }
        : page,
    );
  const root = JSON.parse(
    source.db
      .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
      .get()!.body,
  ) as Record<string, unknown>;
  const manifest = {
    format: "forge-cloud-portable/3",
    head: 1,
    eventWatermark: root.eventWatermark,
    recordFloor: 0,
    publicDigest: root.publicDigest,
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
  };
  const pin = digestBytes(canonicalJson(manifest));
  for (const [page, member] of pages.entries())
    expect(
      await target.send(
        "restore",
        { page, ...member, ...(page === 0 && { manifest }) },
        page === 0 ? { "X-Forge-Manifest-Digest": pin } : {},
      ),
    ).toMatchObject({
      status: 200,
      body: { ok: true, value: { page, verified: page === 2 } },
    });
  expect(await target.send("status")).toMatchObject({
    status: 200,
    body: { ok: true, value: { initialized: true, stopped: true } },
  });
  await run(target);
}

test(
  "admin issue on a provisioned v3 root stores one signed token row",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    expect((await f.send(probe, {})).status).toBe(200);
    await issueAndCheckRow(f);
  },
  timeout,
);

test(
  "admin issue on an activated stopped v3 root stores one signed token row",
  () => withActivated(issueAndCheckRow),
  timeout,
);
