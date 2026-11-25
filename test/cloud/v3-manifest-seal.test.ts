import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { failed } from "../../cloud/src/issue-commands.ts";
import { Project } from "../../cloud/src/project.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  authenticateManifest,
  isVerifiedManifest,
  type Manifest,
  type Seal,
  sealOf,
  signRoot,
  signRow,
  type VerifiedManifest,
  verifyManifest,
} from "../../cloud/src/v3-seal.ts";
import { readV3Value, recoverV3 } from "../../cloud/src/v3-store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  guardFixture,
  newKey,
  noWrites,
  probe,
  recovered,
  trustedManifest,
  verifiedPortable,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const HOUR = 3_600_000;
const MiB = 1024 * 1024;
const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const E1 = T0 + 2 * HOUR;
const FORMAT = "forge-cloud-portable/4";
const typedEnv = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};
const missingUpdate = {
  op: "issue.update",
  requestId: "restored-update",
  input: { id: "forge-9", expectRevision: 1, title: "After" },
  context: { ...holder, leaseGeneration: 1 },
};
const invalidUpdate = {
  ...missingUpdate,
  requestId: "invalid-update",
  input: { ...missingUpdate.input, dependsOn: ["forge-1"] },
};
const unavailable = "Cloud v3 root is unavailable";

beforeEach(() => setSystemTime(T0));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;
interface DirectoryItem {
  collection: string;
  key: string;
  revision?: number;
  offset?: number;
  length?: number;
  digest?: string;
}
interface Portable {
  pages: { id: string; body: string }[];
  head: number;
  eventWatermark: number;
  recordFloor: number;
  publicDigest: string;
  source: string;
}

const restoreRefusal = {
  status: 400,
  body: { ok: false, error: { code: "RESTORE_INVALID_ROW" } },
};
const stopped = {
  status: 200,
  body: { ok: true, value: { initialized: true, stopped: true } },
};
const tableNames = ({ db }: Fixture) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type='table'",
    )
    .all()
    .map(({ name }) => name);
const typed = (f: Fixture, body: Json) =>
  f.send(`${probe}/command`, body, {
    "X-Forge-Owner": "owner-a",
    "X-Forge-Owner-Expires": String(E1),
  });
const rows = ({ db }: Fixture) =>
  db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM cloud_v3_commits")
    .get()!.n;
const stored = (f: Fixture) =>
  tableNames(f)
    .filter((name) => name.startsWith("cloud_v3_"))
    .map((name) => f.db.query(`SELECT * FROM ${name} ORDER BY 1`).all());
const sourceId = (f: Fixture) => String(f.context.id);
const store = (f: Fixture) => writableStore(f.storage);

async function drain(f: Fixture) {
  for (let i = 0; i < 8 && rows(f) > 0; i++)
    expect((await f.send(`${probe}/checkpoint`, {})).status).toBe(200);
  expect(rows(f)).toBe(0);
}

async function typedSource(env = typedEnv) {
  const source = guardFixture(env);
  expect(await source.send(probe, {})).toMatchObject({ status: 200 });
  expect((await typed(source, missingUpdate)).status).toBe(404);
  expect((await typed(source, invalidUpdate)).status).toBe(400);
  await drain(source);
  return source;
}

function backup(source: Fixture): Portable {
  const { head, eventWatermark, recordFloor, root } = recovered(
    store(source),
    source.seal(),
  );
  return {
    pages: source.db
      .query<{ id: string; body: string }, []>(
        "SELECT id, body FROM cloud_v3_pages ORDER BY id",
      )
      .all(),
    head,
    eventWatermark,
    recordFloor,
    publicDigest: root.publicDigest as string,
    source: sourceId(source),
  };
}

let built: Promise<{ source: Fixture; data: Portable }> | undefined;
async function shared() {
  built ??= typedSource().then((source) => ({ source, data: backup(source) }));
  const { source, data } = await built;
  return { source, data: structuredClone(data) };
}

const unsigned = ({ pages, ...rest }: Portable) => ({
  ...rest,
  format: FORMAT,
  pages: pages.map(({ id, body }) => ({
    id,
    bytes: Buffer.byteLength(body),
    hash: digestBytes(body),
  })),
});
const pinOf = (manifest: object) => digestBytes(canonicalJson(manifest));

function uploader(
  target: Fixture,
  manifest: object,
  pages: Portable["pages"],
  pin = pinOf(manifest),
) {
  return (page: number, member = pages[page]!) =>
    target.send(
      "restore",
      { page, ...member, ...(page === 0 && { manifest }) },
      page === 0 ? { "X-Forge-Manifest-Digest": pin } : {},
    );
}

const signedUpload = (target: Fixture, data: Portable, signer = target) =>
  uploader(target, trustedManifest(signer.seal(), unsigned(data)), data.pages);

function forgedUpload(
  target: Fixture,
  data: Portable,
  edit: (m: Json) => void,
) {
  const forged = structuredClone(
    trustedManifest(target.seal(), unsigned(data)),
  ) as unknown as Json;
  edit(forged);
  return uploader(target, forged, data.pages);
}

function rewriteRefusal(data: Portable) {
  const entries = JSON.parse(data.pages[0]!.body) as DirectoryItem[];
  const bytes = Buffer.from(data.pages[1]!.body);
  const text = ({ offset, length }: DirectoryItem) =>
    bytes.subarray(offset, offset! + length!).toString();
  const item = entries.find((e) => text(e).includes('"code":"NOT_FOUND"'))!;
  const saved = JSON.parse(text(item)) as { outcome: { result: Json } };
  Object.assign(saved.outcome.result, { message: "Edited message" });
  const parts = entries.map((e) =>
    e === item ? canonicalJson(saved) : text(e),
  );
  let offset = 0;
  for (const [i, e] of entries.entries()) {
    const length = Buffer.byteLength(parts[i]!);
    Object.assign(e, { offset, length, digest: digestBytes(parts[i]!) });
    offset += length;
  }
  data.pages[1]!.body = parts.join("");
  data.pages[0]!.body = canonicalJson(entries);
  data.publicDigest = digestBytes(
    canonicalJson(
      entries.map(({ collection, key, revision, digest }) => [
        collection,
        key,
        revision === undefined
          ? (digest ?? null)
          : digestBytes(canonicalJson([revision, digest ?? null])),
      ]),
    ),
  );
  const frames = JSON.parse(data.pages[2]!.body) as Json[];
  const { outcome } = frames.find((f) => (f.outcome as Json).id === item.key)!;
  (outcome as Json).resultDigest = digestBytes(
    canonicalJson(saved.outcome.result),
  );
  data.pages[2]!.body = canonicalJson(frames);
}

async function refused(target: Fixture, send: () => Promise<unknown>) {
  expect(
    await target.send("restore", { page: 9, id: "warm-up", body: "" }),
  ).toMatchObject(restoreRefusal);
  const effects = target.observeEffects();
  expect(await send()).toMatchObject(restoreRefusal);
  expect(effects()).toEqual(noWrites);
  expect(
    tableNames(target).filter((name) => name.startsWith("cloud_v3_")),
  ).toEqual([]);
}

test(
  "v3 restore refuses a rewritten backup whose pages and pin were recomputed but whose mac is the original",
  async () => {
    const { data } = await shared();
    const target = guardFixture(typedEnv);
    using _db = target.db;
    const honest = trustedManifest(target.seal(), unsigned(data));
    rewriteRefusal(data);
    const forged = { ...unsigned(data), mac: honest.mac };
    await refused(target, () => uploader(target, forged, data.pages)(0));
  },
  timeout,
);

test(
  "v3 restore refuses the same rewritten backup when a trusted signer signs it and still restores the untouched signed backup",
  async () => {
    const { source, data } = await shared();
    const wire = (r: { body: unknown }) =>
      (r.body as { error: ForgeError }).error;
    const exit = (r: { body: unknown }) => exitCode(failed(wire(r)));
    const originals = [];
    for (const body of [missingUpdate, invalidUpdate])
      originals.push([body, await typed(source, body)] as const);
    expect(originals.map(([, r]) => [r.status, wire(r).code, exit(r)])).toEqual(
      [
        [404, "NOT_FOUND", 3],
        [400, "INPUT_INVALID", 6],
      ],
    );
    const sibling = guardFixture(typedEnv);
    using _sibling = sibling.db;
    const honest = signedUpload(sibling, data);
    expect(await honest(0)).toMatchObject({ status: 200 });
    expect(await honest(1)).toMatchObject({ status: 200 });
    expect(await honest(2)).toMatchObject({
      status: 200,
      body: { value: { page: 2, verified: true } },
    });
    sibling.restart();
    for (const [body, reply] of originals) {
      const replay = sibling.observeEffects();
      const again = await typed(sibling, body);
      expect(again).toEqual(reply);
      expect(exit(again)).toBe(exit(reply));
      expect(replay()).toEqual(noWrites);
    }
    const target = guardFixture(typedEnv);
    using _db = target.db;
    const tables = tableNames(target);
    const { kv } = target.snapshot();
    rewriteRefusal(data);
    const upload = signedUpload(target, data);
    expect(await upload(0)).toMatchObject({ status: 200 });
    expect(await upload(1)).toMatchObject({ status: 200 });
    for (const attempt of [1, 2]) {
      const effects = target.observeEffects();
      const reply = await upload(2);
      expect(reply).toEqual({
        status: 400,
        body: {
          ok: false,
          error: {
            code: "RESTORE_INVALID_ROW",
            message: "Cloud v3 portable restore could not be verified",
            retry: "never",
          },
        },
      });
      expect(exit(reply)).toBe(1);
      expect(tableNames(target)).not.toContain("cloud_v3_restore");
      expect(tableNames(target)).toEqual(tables);
      expect(target.snapshot().kv).toEqual(kv);
      expect(effects()).toEqual(
        attempt === 1
          ? { sqlWriteAttempts: 2, alarmWrites: 0, sqlAndKvIntact: false }
          : noWrites,
      );
    }
  },
  timeout,
);

const edits: [string, (m: Json) => void][] = [
  ["a changed source", (m) => (m.source = "another-source")],
  ["an empty source", (m) => (m.source = "")],
  ["a non-string source", (m) => (m.source = 7)],
  ["a missing source", (m) => delete m.source],
  ["a changed head", (m) => (m.head = (m.head as number) + 1)],
  [
    "a changed event watermark",
    (m) => (m.eventWatermark = (m.eventWatermark as number) + 1),
  ],
  ["a changed record floor", (m) => (m.recordFloor = 9)],
  ["a changed public digest", (m) => (m.publicDigest = digestBytes("other"))],
  [
    "a changed page hash",
    (m) => ((m.pages as Json[])[1]!.hash = digestBytes("other")),
  ],
  [
    "a changed page size",
    (m) =>
      ((m.pages as Json[])[1]!.bytes =
        1 + ((m.pages as Json[])[1]!.bytes as number)),
  ],
  ["a missing mac", (m) => delete m.mac],
  ["an empty mac", (m) => (m.mac = "")],
  ["an uppercase mac", (m) => (m.mac = String(m.mac).toUpperCase())],
  ["a mac with two dots", (m) => (m.mac = String(m.mac).replace(".", ".."))],
  ["a short tag", (m) => (m.mac = String(m.mac).slice(0, -1))],
  ["a long tag", (m) => (m.mac = `${String(m.mac)}0`)],
  [
    "a wrong tag",
    (m) => (m.mac = `${String(m.mac).slice(0, 17)}${"0".repeat(64)}`),
  ],
  [
    "an unknown key id",
    (m) => (m.mac = `${"1".repeat(16)}${String(m.mac).slice(16)}`),
  ],
];

for (const [name, edit] of edits)
  test(
    `v3 restore refuses a manifest with ${name} and a pin recomputed over it`,
    async () => {
      const { data } = await shared();
      const target = guardFixture(typedEnv);
      using _db = target.db;
      await refused(target, () => forgedUpload(target, data, edit)(0));
    },
    timeout,
  );

for (const [name, domain] of [
  ["a root", (f: Fixture) => signRoot(f.seal(), "{}")],
  ["a commit row", (f: Fixture) => signRow(f.seal(), "incarnation", 1, "{}")],
] as const)
  test(
    `v3 restore refuses ${name} envelope from the same key in place of the manifest mac`,
    async () => {
      const { data } = await shared();
      const target = guardFixture(typedEnv);
      using _db = target.db;
      const send = forgedUpload(target, data, (m) => {
        m.mac = domain(target);
      });
      await refused(target, () => send(0));
    },
    timeout,
  );

for (const [name, build] of [
  [
    "a six-member old-format manifest with a correct pin",
    (target: Fixture, data: Portable) => {
      const {
        source: _source,
        mac: _mac,
        ...six
      } = trustedManifest(target.seal(), unsigned(data));
      return { ...six, format: "forge-cloud-portable/3" };
    },
  ],
  [
    "a signed manifest named with the old format",
    (target: Fixture, data: Portable) =>
      trustedManifest(target.seal(), {
        ...unsigned(data),
        format: "forge-cloud-portable/3",
      }),
  ],
  [
    "a signed and pinned manifest with a ninth member",
    (target: Fixture, data: Portable) => {
      const nine = { ...unsigned(data), extra: true };
      return trustedManifest(target.seal(), nine);
    },
  ],
] as const)
  test(
    `v3 restore refuses ${name}`,
    async () => {
      const { data } = await shared();
      const target = guardFixture(typedEnv);
      using _db = target.db;
      const send = uploader(target, build(target, data), data.pages);
      await refused(target, () => send(0));
    },
    timeout,
  );

test(
  "v3 restore admits a signed manifest only when the pin covers the full envelope",
  async () => {
    const { data } = await shared();
    const target = guardFixture(typedEnv);
    using _db = target.db;
    const manifest = trustedManifest(target.seal(), unsigned(data));
    const { mac: _mac, ...bare } = manifest;
    const bareSend = uploader(target, manifest, data.pages, pinOf(bare));
    await refused(target, () => bareSend(0));
    expect(await uploader(target, manifest, data.pages)(0)).toMatchObject({
      status: 200,
      body: { value: { page: 0, verified: false } },
    });
  },
  timeout,
);

test(
  "v3 restore refuses a staged manifest rewritten together with its pin while keeping the original mac",
  async () => {
    const { data } = await shared();
    const target = guardFixture(typedEnv);
    using _db = target.db;
    const upload = signedUpload(target, data);
    expect((await upload(0)).status).toBe(200);
    const saved = target.db
      .query<{ manifest: string }, []>(
        "SELECT manifest FROM cloud_v3_restore WHERE id='directory:0'",
      )
      .get()!;
    const manifest = JSON.parse(saved.manifest) as Manifest & {
      pages: { id: string; bytes: number; hash: string }[];
    };
    const body = "tampered";
    manifest.pages[1] = {
      id: "snapshot:0",
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    };
    target.db.run(
      "UPDATE cloud_v3_restore SET manifest=?, pin=? WHERE id='directory:0'",
      [canonicalJson(manifest), pinOf(manifest)],
    );
    const before = stored(target);
    const reply = await upload(1, { id: "snapshot:0", body });
    expect(reply.status).toBe(400);
    expect(reply).toMatchObject(restoreRefusal);
    expect(stored(target)).toEqual(before);
    expect(
      target.db.query("SELECT id FROM cloud_v3_restore").all(),
    ).toHaveLength(1);
  },
  timeout,
);

test(
  "v3 restore treats parse-equivalent spellings of a signed manifest as the same manifest",
  async () => {
    const { data } = await shared();
    const target = guardFixture(typedEnv);
    using _db = target.db;
    const manifest = trustedManifest(target.seal(), unsigned(data));
    const code = manifest.source.charCodeAt(0).toString(16).padStart(4, "0");
    const reversed = (o: object) =>
      Object.fromEntries(Object.entries(o).reverse());
    const spelled = JSON.stringify(
      reversed({
        ...manifest,
        pages: manifest.pages.map((member) => reversed(member)),
      }),
      null,
      2,
    ).replace(`"source": "${manifest.source[0]}`, `"source": "\\u${code}`);
    expect(spelled).toContain("\\u");
    const first = data.pages[0]!;
    const text = `{ "manifest": ${spelled}, "body": ${JSON.stringify(first.body)}, "id": "directory:0", "page": 0 }`;
    const raw = () =>
      new Project(target.context, target.env).fetch(
        new Request("https://fixture.example/p/a/restore", {
          method: "POST",
          headers: { "X-Forge-Manifest-Digest": pinOf(manifest) },
          body: text,
        }),
      );
    const reply = await raw();
    expect(reply.status).toBe(200);
    const original = await reply.json();
    target.db.run(
      "UPDATE cloud_v3_restore SET manifest=? WHERE id='directory:0'",
      [JSON.stringify(manifest, null, 4)],
    );
    const upload = uploader(target, manifest, data.pages);
    expect(await upload(1)).toMatchObject({ status: 200 });
    expect(await upload(2)).toMatchObject({
      status: 200,
      body: { value: { page: 2, verified: true } },
    });
    expect(await (await raw()).json()).toEqual(original);
    expect(await target.send("status")).toMatchObject(stopped);
  },
  timeout,
);

test(
  "v3 restore accepts a backup signed under another deployment's key when it is the previous key, and re-signs under its own",
  async () => {
    const { source, data } = await shared();
    const previous = source.env.V3_SEAL_KEY as string;
    const target = guardFixture(typedEnv, { previous });
    using _db = target.db;
    const upload = signedUpload(target, data, source);
    expect(await upload(0)).toMatchObject({ status: 200 });
    expect(await upload(1)).toMatchObject({ status: 200 });
    expect(await upload(2)).toMatchObject({
      status: 200,
      body: { value: { page: 2, verified: true } },
    });
    target.restart();
    expect(await target.send("status")).toMatchObject(stopped);
    const own = target.seal().keys[0].id;
    const root = target.db
      .query<{ seal: string }, []>("SELECT seal FROM cloud_v3_root")
      .get()!;
    const row = target.db
      .query<{ mac: string }, []>("SELECT mac FROM cloud_v3_commits")
      .get()!;
    expect([root.seal.slice(0, 16), row.mac.slice(0, 16)]).toEqual([own, own]);
    const saved = target.db
      .query<{ manifest: string }, []>(
        "SELECT manifest FROM cloud_v3_restore WHERE id='directory:0'",
      )
      .get()!;
    const { source: from } = JSON.parse(saved.manifest) as Manifest;
    expect(from).toBe(sourceId(source));
    expect(from).not.toBe(sourceId(target));
  },
  timeout,
);

test(
  "v3 restore refuses a backup signed under another deployment's key when the target has only its own key",
  async () => {
    const { source, data } = await shared();
    const target = guardFixture(typedEnv);
    using _db = target.db;
    const send = signedUpload(target, data, source);
    await refused(target, () => send(0));
  },
  timeout,
);

test(
  "v3 restore keeps staged pages when the signing key is removed before the final page",
  async () => {
    const { source, data } = await shared();
    const previous = source.env.V3_SEAL_KEY as string;
    const target = guardFixture(typedEnv, { previous });
    using _db = target.db;
    const upload = signedUpload(target, data, source);
    for (const page of [0, 1])
      expect(await upload(page)).toMatchObject({
        status: 200,
        body: { value: { page, verified: false } },
      });
    const staged = target.snapshot();
    delete target.env.V3_SEAL_KEY_PREVIOUS;
    target.restart();
    const effects = target.observeEffects();
    const reply = await upload(2);
    expect(reply).toMatchObject(restoreRefusal);
    expect(exitCode(failed((reply.body as { error: ForgeError }).error))).toBe(
      1,
    );
    expect(effects()).toEqual(noWrites);
    expect(target.snapshot()).toEqual(staged);

    target.env.V3_SEAL_KEY_PREVIOUS = previous;
    target.restart();
    expect(await upload(2)).toMatchObject({
      status: 200,
      body: { value: { page: 2, verified: true } },
    });
  },
  timeout,
);

test(
  "v3 restore refuses saved retries once the source key is removed and accepts them again when it returns",
  async () => {
    const { source, data } = await shared();
    const previous = source.env.V3_SEAL_KEY as string;
    const target = guardFixture(typedEnv, { previous });
    using _db = target.db;
    const upload = signedUpload(target, data, source);
    for (const page of [0, 1, 2]) await upload(page);
    const retry = async () => [
      await upload(0),
      await upload(1),
      await upload(2),
    ];
    delete target.env.V3_SEAL_KEY_PREVIOUS;
    target.restart();
    expect(await target.send("status")).toMatchObject(stopped);
    const before = stored(target);
    expect(await retry()).toMatchObject([
      restoreRefusal,
      restoreRefusal,
      restoreRefusal,
    ]);
    expect(stored(target)).toEqual(before);
    target.env.V3_SEAL_KEY_PREVIOUS = previous;
    target.restart();
    expect(await retry()).toMatchObject([
      { status: 200, body: { value: { page: 0, verified: false } } },
      { status: 200, body: { value: { page: 1, verified: false } } },
      { status: 200, body: { value: { page: 2, verified: true } } },
    ]);
    expect(stored(target)).toEqual(before);
  },
  timeout,
);

test(
  "v3 portable recovery refuses a verified manifest paired with another transcript, and any lookalike",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    expect((await f.send(probe, {})).status).toBe(200);
    const seal = f.seal();
    const put = (value: string, tail: unknown[] = []) =>
      canonicalJson([
        {
          changes: [{ key: "r1", value: { revision: 1, value } }],
          events: [{ key: "r1", revision: 1, value }],
          format: "forge-cloud-commit/3",
          operation: "fixture.put",
          sequence: 1,
          time: 0,
        },
        ...tail,
      ]);
    const [a, b, longer] = [put("a"), put("b"), put("a", [{ sequence: 2 }])];
    expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b));
    const admit = Project.admitLeaseRequest;
    const fold = (manifest: unknown, portableTranscript: string) =>
      recoverV3(store(f), seal, {
        admit,
        manifest: manifest as VerifiedManifest,
        portableTranscript,
      });
    const value = verifiedPortable(seal, a);
    const folds = f.observeEffects();
    expect(fold(value, a).head).toBe(1);
    expect(fold(verifiedPortable(seal, b), b).head).toBe(1);
    expect(fold(verifiedPortable(seal, longer), longer).head).toBe(2);
    expect(folds()).toEqual(noWrites);
    const refuse = (call: () => unknown) => {
      const effects = f.observeEffects();
      expect(call).toThrow(unavailable);
      expect(effects()).toEqual(noWrites);
    };
    refuse(() => fold(value, b));
    refuse(() => fold(value, longer));
    for (const lookalike of [
      { ...value },
      Object.create(null, Object.getOwnPropertyDescriptors(value)),
      null,
      undefined,
      {},
    ]) {
      expect(isVerifiedManifest(lookalike)).toBe(false);
      refuse(() => fold(lookalike, a));
    }
    expect(isVerifiedManifest(value)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    const loose = {
      admit,
      pages: new Map<string, Buffer>(),
      sealed: () => {},
      portableTranscript: a,
    };
    const st = store(f);
    // @ts-expect-error a portable transcript needs a verified manifest
    const raw = () => recoverV3(st, seal, { admit, portableTranscript: a });
    // @ts-expect-error the ordinary overload excludes a portable transcript
    const ordinary = () => recoverV3(st, seal, loose);
    refuse(raw);
    refuse(ordinary);
  },
  timeout,
);

const member = (id: string, body: string) => ({
  id,
  bytes: Buffer.byteLength(body),
  hash: digestBytes(body),
});
const firstPages = [member("directory:0", "[]"), member("snapshot:0", "")];
const signPages = async (seal: Seal, pages: unknown) =>
  trustedManifest(seal, {
    ...unsigned((await shared()).data),
    pages: pages as Manifest["pages"],
  });

test.each(["Proxy", "getter", "forged first", "honest"] as const)(
  "v3 authentication uses the pinned pages with %s input",
  async (kind) => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    expect((await f.send(probe, {})).status).toBe(200);
    const put = (value: "a" | "b") =>
      `[{"changes":[{"key":"r1","value":{"revision":1,"value":"${value}"}}],` +
      `"events":[{"key":"r1","revision":1,"value":"${value}"}],` +
      '"format":"forge-cloud-commit/3","operation":"fixture.put","sequence":1,"time":0}]';
    const [a, b] = [put("a"), put("b")];
    expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b));
    const seal = f.seal();
    const transcript = member("transcript:0", a);
    const honest = await signPages(seal, [...firstPages, transcript]);
    const pin = pinOf(honest);
    const changed = [...firstPages, member("transcript:0", b)];
    const first = kind === "forged first";
    const answers = first ? [changed] : [honest.pages, honest.pages];
    const readPages = () => answers.shift() ?? (first ? honest.pages : changed);
    const get = (target: Manifest, key: PropertyKey): unknown =>
      key === "pages" ? readPages() : Reflect.get(target, key);
    let wrapped = honest;
    if (kind === "getter")
      wrapped = Object.defineProperty({ ...honest }, "pages", {
        get: readPages,
      });
    else if (kind !== "honest") wrapped = new Proxy(honest, { get });
    const value = authenticateManifest(seal, wrapped, pin);
    if (first) return expect(value).toBeUndefined();
    const proof = { admit: Project.admitLeaseRequest, manifest: value! };
    const folds = [a, b].map((portableTranscript) => {
      const effects = f.observeEffects();
      const input = { ...proof, portableTranscript };
      let result: unknown;
      try {
        result = recoverV3(store(f), seal, input).head;
      } catch (error) {
        result = error instanceof ForgeFailure ? error.error.code : error;
      }
      return [result, effects()];
    });
    expect([value?.transcript, value?.members, ...folds]).toEqual([
      transcript,
      honest.pages,
      [1, noWrites],
      ["UNAVAILABLE", noWrites],
    ]);
    expect(isVerifiedManifest(value)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
  },
  timeout,
);

const transcript = member("transcript:0", "a");
const badMembers = [
  ["renamed transcript", { ...transcript, id: "transcript:1" }],
  ["empty transcript", { id: "transcript:0" }],
  ["string bytes", { ...transcript, bytes: "12" }],
  ["negative bytes", { ...transcript, bytes: -1 }],
  ["fractional bytes", { ...transcript, bytes: 1.5 }],
  ["number hash", { ...transcript, hash: 7 }],
  ["uppercase hash", { ...transcript, hash: transcript.hash.toUpperCase() }],
  ["short hash", { ...transcript, hash: "sha256:abc" }],
] as const;
test.each([
  ...badMembers.map(([label, page]) => [label, [...firstPages, page]] as const),
  ["missing transcript", firstPages],
  ["duplicate transcript", [...firstPages, transcript, transcript]],
  ["null page", [...firstPages, transcript, null]],
  ["non-array pages", { transcript }],
] as const)(
  "v3 authentication refuses signed and pinned pages with %s",
  async (_label, pages) => {
    const seal = sealOf({ V3_SEAL_KEY: newKey() }, { toString: () => "f" });
    const signed = await signPages(seal, pages);
    expect(authenticateManifest(seal, signed, pinOf(signed))).toBeUndefined();
  },
  timeout,
);

test.each(["its own pin", "a wrong pin"] as const)(
  "v3 authentication refuses sparse pages pinned by %s without throwing",
  async (kind) => {
    const seal = sealOf({ V3_SEAL_KEY: newKey() }, { toString: () => "f" });
    const signed = await signPages(seal, new Array(2));
    const pin = kind === "its own pin" ? pinOf(signed) : digestBytes("other");
    expect(authenticateManifest(seal, signed, pin)).toBeUndefined();
  },
  timeout,
);

test(
  "v3 manifest signed bytes cover every member except the mac, under their own domain",
  () => {
    const seal = sealOf({ V3_SEAL_KEY: newKey() }, { toString: () => "x" });
    const member = (id: string) => ({
      id,
      bytes: 2,
      hash: digestBytes(id),
    });
    const bare = {
      format: FORMAT,
      head: 1,
      eventWatermark: 2,
      recordFloor: 3,
      publicDigest: digestBytes("p"),
      pages: ["directory:0", "snapshot:0", "transcript:0"].map(member),
      source: "s",
    };
    const honest = trustedManifest(seal, bare);
    expect(verifyManifest(seal, honest)).toBe(true);
    const changed: Json[] = [
      { format: "forge-cloud-portable/3" },
      { head: 2 },
      { eventWatermark: 3 },
      { recordFloor: 4 },
      { publicDigest: digestBytes("q") },
      { pages: [...bare.pages.slice(1), bare.pages[0]!] },
      { source: "t" },
    ];
    for (const edit of changed)
      expect(verifyManifest(seal, { ...honest, ...edit })).toBe(false);
    const withMac = trustedManifest(seal, {
      ...bare,
      mac: honest.mac,
    } as typeof bare);
    expect(verifyManifest(seal, withMac)).toBe(false);
    const root = signRoot(seal, canonicalJson(["forge/v3/manifest/1", bare]));
    expect(verifyManifest(seal, { ...honest, mac: root })).toBe(false);
  },
  timeout,
);

test(
  "v3 restore admits a page 0 request of exactly 2 MiB with a multibyte source and refuses one byte more",
  async () => {
    const { data } = await shared();
    const target = guardFixture(typedEnv);
    using _db = target.db;
    const sized = (pad: number) =>
      trustedManifest(target.seal(), {
        ...unsigned(data),
        source: `é${"x".repeat(pad)}`,
      });
    const request = (pad: number) =>
      Buffer.byteLength(
        JSON.stringify({ page: 0, ...data.pages[0], manifest: sized(pad) }),
      );
    const fit = 2 * MiB - request(0);
    expect(request(fit)).toBe(2 * MiB);
    expect(await uploader(target, sized(fit + 1), data.pages)(0)).toMatchObject(
      {
        status: 413,
        body: { error: { code: "RESTORE_TOO_LARGE" } },
      },
    );
    expect(tableNames(target)).not.toContain("cloud_v3_restore");
    expect(await uploader(target, sized(fit), data.pages)(0)).toMatchObject({
      status: 200,
    });
  },
  timeout,
);

test(
  "v3 restore of an older genuine backup activates the older image in two targets with other ids, a stated limit",
  async () => {
    const source = await typedSource();
    const older = backup(source);
    expect(
      (await typed(source, { ...invalidUpdate, requestId: "newer-update" }))
        .status,
    ).toBe(400);
    await drain(source);
    const newer = backup(source);
    expect(newer.head).toBeGreaterThan(older.head);
    const previous = source.env.V3_SEAL_KEY as string;
    for (const _ of [0, 1]) {
      const target = guardFixture(typedEnv, { key: previous });
      using _db = target.db;
      const upload = signedUpload(target, older, source);
      expect(await upload(0)).toMatchObject({ status: 200 });
      expect(await upload(1)).toMatchObject({ status: 200 });
      expect(await upload(2)).toMatchObject({
        body: { value: { verified: true } },
      });
      expect(await target.send("status")).toMatchObject(stopped);
      expect(recovered(store(target), target.seal()).head).toBe(older.head + 1);
    }
  },
  timeout,
);

test(
  "v3 restore keeps ids shown under a historical prefix when the target prefix differs",
  async () => {
    const alpha = { ...typedEnv, FORGE_CLOUD_ID_PREFIX: "alpha" };
    const source = guardFixture(alpha);
    const target = guardFixture({ ...typedEnv, FORGE_CLOUD_ID_PREFIX: "beta" });
    using _source = source.db;
    using _target = target.db;
    expect(await source.send(probe, {})).toMatchObject({ status: 200 });
    const record = { id: "work-1", status: "open", dependsOn: [] };
    expect(
      (
        await source.send(`${probe}/commits`, {
          frames: [
            {
              operation: "fixture.put",
              time: Date.now(),
              events: [{ key: "r1", revision: 1, value: record }],
              changes: [{ key: "r1", value: { revision: 1, value: record } }],
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      await typed(source, {
        op: "issue.claim",
        requestId: "refused-claim",
        input: { id: "alpha-9" },
        context: holder,
      }),
    ).toMatchObject({ status: 404 });
    await drain(source);
    const upload = signedUpload(target, backup(source));
    expect(await upload(0)).toMatchObject({ status: 200 });
    expect(await upload(1)).toMatchObject({ status: 200 });
    expect(await upload(2)).toMatchObject({
      body: { value: { verified: true } },
    });
    expect(await target.send("status")).toMatchObject(stopped);
    const restored = recovered(store(target), target.seal());
    const [key] = [...restored.entries.outcome.keys()];
    expect(
      JSON.stringify(readV3Value(store(target), restored, "outcome", key!)),
    ).toContain("Issue alpha-9 was not found");
    expect(readV3Value(store(target), restored, "record", "r1")).toEqual(
      record,
    );
  },
  timeout,
);
