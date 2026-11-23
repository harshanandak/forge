import { expect, test } from "bun:test";
import { failed } from "../../cloud/src/issue-commands.ts";
import { verifyRoot } from "../../cloud/src/v3-seal.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  isObject,
} from "../../src/core/config/pointer.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  fixture,
  guardFixture,
  noWrites,
  portableOf,
  portableUpload,
  probe,
  sqlMutation,
  trustedSeal,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const format = "forge-cloud-root/4";
const frames = [
  {
    operation: "fixture.put",
    time: 1000,
    events: [
      { key: "r1", revision: 1, value: "a" },
      { key: "r2", revision: 1, value: "b" },
    ],
    changes: [
      { key: "r1", value: { revision: 1, value: "a" } },
      { key: "r2", value: { revision: 1, value: "b" } },
    ],
  },
  { operation: "fixture.note", time: 1001, events: [] },
  {
    operation: "fixture.delete",
    time: 1002,
    events: [{ key: "r1", revision: 2 }],
    changes: [{ key: "r1", value: { revision: 2, deleted: true } }],
  },
] as const;

test(
  "a disposable v3 project reads back its entire sealed root after restart",
  async () => {
    const f = fixture();
    try {
      const provisioned = await f.send(probe, {});
      expect(provisioned).toMatchObject({
        status: 200,
        body: {
          ok: true,
          value: {
            format,
            coveredHead: 0,
            eventWatermark: 0,
            counts: { directory: 0, transcript: 0 },
            pages: [
              { id: "directory:0", kind: "directory", ordinal: 0, count: 0 },
              { id: "transcript:0", kind: "transcript", ordinal: 0, count: 0 },
            ],
          },
        },
      });
      const before = f.snapshot();
      f.restart();
      expect(await f.send(probe)).toEqual(provisioned);
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.db.close();
    }
  },
  timeout,
);

const reorderedPages =
  "json_set(body,'$.pages',json_array(json_extract(body,'$.pages[1]'),json_extract(body,'$.pages[0]')))";

const corruptions = [
  ["missing page", "DELETE FROM cloud_v3_pages WHERE id='directory:0'"],
  [
    "extra page",
    "INSERT INTO cloud_v3_pages (id, body) SELECT 'foreign:0', body FROM cloud_v3_pages WHERE id='directory:0'",
  ],
  [
    "page with bytes after a NUL",
    "UPDATE cloud_v3_pages SET body=body||char(0)||'extra' WHERE id='directory:0'",
  ],
  ["reordered roster", `UPDATE cloud_v3_root SET body=${reorderedPages}`],
  [
    "wrong covered head",
    "UPDATE cloud_v3_root SET body=json_set(body,'$.coveredHead',1)",
  ],
  [
    "wrong event watermark",
    "UPDATE cloud_v3_root SET body=json_set(body,'$.eventWatermark',1)",
  ],
  [
    "wrong projection count",
    "UPDATE cloud_v3_root SET body=json_set(body,'$.counts.directory',1)",
  ],
] as const;

for (const [label, sql] of corruptions) {
  test(
    `v3 recovery refuses a ${label} without activating anything`,
    async () => {
      const f = fixture();
      try {
        const provisioned = await f.send(probe, {});
        if (provisioned.status === 200) expect(f.db.run(sql).changes).toBe(1);
        const before = f.snapshot();
        f.restart();
        const read = await f.send(probe);
        expect(read).toMatchObject({
          status: 503,
          body: { ok: false, error: { code: "UNAVAILABLE" } },
        });
        expect(read.body).not.toHaveProperty("value");
        expect(f.snapshot()).toEqual(before);
        expect(provisioned.status).toBe(200);
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

function reformat(f: ReturnType<typeof fixture>, value: string) {
  const { body } = f.db
    .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
    .get()!;
  const next = canonicalJson({ ...JSON.parse(body), format: value });
  f.db.run("UPDATE cloud_v3_root SET body=?, seal=?", [
    next,
    trustedSeal(f.db, next),
  ]);
}

type Fixture = ReturnType<typeof guardFixture>;
async function sourceOf(opened: Set<Fixture>, history: boolean) {
  const f = guardFixture();
  opened.add(f);
  expect((await f.send(probe, {})).status).toBe(200);
  if (history) {
    const put = await f.send(`${probe}/commits`, { frames: [frames[0]] });
    expect(put.status).toBe(200);
    expect((await f.send(`${probe}/checkpoint`, {})).status).toBe(200);
    f.restart();
  }
  return f;
}
const roots: [string, (opened: Set<Fixture>) => Promise<Fixture>][] = [
  ["genesis", (opened) => sourceOf(opened, false)],
  ["checkpointed", (opened) => sourceOf(opened, true)],
  [
    "activated",
    async (opened) => {
      const from = await sourceOf(opened, true);
      const target = guardFixture();
      opened.add(target);
      const upload = portableUpload(target, portableOf(from));
      for (const page of [0, 1, 2])
        expect((await upload(page)).status).toBe(200);
      target.restart();
      return target;
    },
  ],
];
for (const [label, make] of roots)
  test(
    `v3 reads a ${label} root as ${format} and refuses its previous format with a valid seal`,
    async () => {
      const opened = new Set<Fixture>();
      try {
        const f = await make(opened);
        expect(await f.send(probe)).toMatchObject({
          status: 200,
          body: { ok: true, value: { format } },
        });
        reformat(f, "forge-cloud-root/3");
        const before = f.snapshot();
        f.restart();
        const effects = f.observeEffects();
        const read = await f.send(probe);
        expect(read).toEqual({
          status: 503,
          body: {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Cloud v3 root is unavailable",
              retry: "never",
            },
          },
        });
        const error = (read.body as { error: ForgeError }).error;
        expect(exitCode(failed(error))).toBe(1);
        expect(effects()).toEqual(noWrites);
        expect(f.snapshot()).toEqual(before);
      } finally {
        for (const f of opened) f.db.close();
      }
    },
    timeout,
  );

test(
  "v3 recovery rejects a reordered roster with a valid recomputed seal",
  async () => {
    const f = fixture();
    try {
      const provisioned = await f.send(probe, {});
      f.restart();
      const pristine = await f.send(probe);
      if (provisioned.status === 200) {
        expect(pristine).toEqual(provisioned);
        const root = f.db.query<{ body: string; seal: string }, []>(
          "SELECT body, seal FROM cloud_v3_root",
        );
        const original = root.get()!;
        expect(verifyRoot(f.seal(), original.body, original.seal)).toBe(true);
        const changed = f.db
          .query<{ body: string }, []>(
            `SELECT ${reorderedPages} AS body FROM cloud_v3_root`,
          )
          .get()!;
        const body = canonicalJson(JSON.parse(changed.body));
        const seal = trustedSeal(f.db, body);
        expect(seal).not.toBe(original.seal);
        expect(
          f.db.run("UPDATE cloud_v3_root SET body=?, seal=?", [body, seal])
            .changes,
        ).toBe(1);
        expect(root.get()).toEqual({ body, seal });
      }
      const before = f.snapshot();
      f.restart();
      const read = await f.send(probe);
      expect(read).toMatchObject({
        status: 503,
        body: { ok: false, error: { code: "UNAVAILABLE" } },
      });
      expect(read.body).not.toHaveProperty("value");
      expect(f.snapshot()).toEqual(before);
      expect(provisioned.status).toBe(200);
    } finally {
      f.db.close();
    }
  },
  timeout,
);

test(
  "the same commits retain identical ordered frame bytes across an append after restart",
  async () => {
    const next = {
      operation: "fixture.put",
      time: 1003,
      events: [{ key: "r3", revision: 1, value: "c" }],
      changes: [{ key: "r3", value: { revision: 1, value: "c" } }],
    };
    const expected = [...frames, next].map((frame, i) => ({
      sequence: i + 1,
      body: canonicalJson({
        ...frame,
        format: "forge-cloud-commit/3",
        sequence: i + 1,
      }),
    }));
    const read = async () => {
      const f = fixture();
      try {
        const provisioned = await f.send(probe, {});
        const appended = await f.send(`${probe}/commits`, { frames });
        expect(appended.status).toBe(200);
        expect(provisioned.status).toBe(200);
        const rows = f.db.query<{ sequence: number; body: string }, []>(
          "SELECT sequence, body FROM cloud_v3_commits ORDER BY sequence",
        );
        const before = rows.all();
        expect(before).toEqual(expected.slice(0, 3));
        f.restart();
        expect(
          (await f.send(`${probe}/commits`, { frames: [next] })).status,
        ).toBe(200);
        const after = rows.all();
        expect(after).toHaveLength(4);
        expect(after.slice(0, 3)).toEqual(before);
        expect(after[3]).toEqual(expected[3]);
        return after;
      } finally {
        f.db.close();
      }
    };
    const first = await read();
    expect(first).toEqual(expected);
    expect(await read()).toEqual(first);
  },
  timeout,
);

for (const keepMarker of [true, false]) {
  test(
    `v3 provisioning refuses v2 rows ${keepMarker ? "with" : "without"} a provisioning marker`,
    async () => {
      const f = fixture();
      try {
        f.restart(false);
        expect(
          (await f.send("devices", { device: "fixture", ttlMs: 60_000 }))
            .status,
        ).toBe(200);
        if (!keepMarker) expect(f.values.delete("provisioned")).toBe(true);
        const before = f.snapshot();
        f.restart();
        const response = await f.send(probe, {});
        expect(response).toMatchObject({
          status: 409,
          body: {
            ok: false,
            error: {
              code: "INPUT_CONFLICT",
              message: "Cloud v3 requires a fresh project",
            },
          },
        });
        expect(f.snapshot()).toEqual(before);
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

test(
  "ordinary v2 provisioning and upgrade refuse a stored v3 root before any write",
  async () => {
    const check = async (route: string, input?: unknown) => {
      let sqlWriteAttempts = 0;
      const f = fixture((sql) => {
        if (sqlMutation.test(sql)) sqlWriteAttempts++;
      });
      try {
        const provisioned = await f.send(probe, {});
        if (provisioned.status === 404) {
          const body = canonicalJson({ format, coveredHead: 0, pages: [] });
          f.db.exec(
            "CREATE TABLE cloud_v3_root (id INTEGER PRIMARY KEY, body TEXT NOT NULL, seal TEXT NOT NULL)",
          );
          f.db.run("INSERT INTO cloud_v3_root VALUES (1, ?, ?)", [
            body,
            digestBytes(body),
          ]);
        }
        const before = f.snapshot();
        sqlWriteAttempts = 0;
        f.restart(false);
        const { status, body } = await f.send(route, input);
        const after = f.snapshot();
        const error = isObject(body) && isObject(body.error) ? body.error : {};
        return {
          route,
          status,
          code: error.code,
          message: error.message,
          sqlWriteAttempts,
          storageIntact:
            Buffer.from(before.sql).equals(after.sql) &&
            JSON.stringify(before.kv) === JSON.stringify(after.kv),
        };
      } finally {
        f.db.close();
      }
    };
    const actual = await Promise.all([
      check("devices", { device: "fixture", ttlMs: 60_000 }),
      check("upgrade"),
    ]);
    const refused = {
      status: 409,
      code: "INPUT_CONFLICT",
      message: "Cloud v3 projects cannot use v2 routes",
      sqlWriteAttempts: 0,
      storageIntact: true,
    };
    expect(actual).toEqual([
      { route: "devices", ...refused },
      { route: "upgrade", ...refused },
    ]);
  },
  timeout,
);

test(
  "a stale v2 provisioning marker cannot make an alarm enter v2 maintenance on a v3 root",
  async () => {
    const f = guardFixture();
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      f.values.set("provisioned", true);
      const effects = f.observeEffects();
      f.restart(false);
      const result = await f.alarm().then(
        () => "returned",
        (error: unknown) =>
          error instanceof ForgeFailure
            ? error.error.code
            : "unexpected rejection",
      );
      expect({ result, ...effects() }).toEqual({
        result: "returned",
        ...noWrites,
      });
    } finally {
      f.db.close();
    }
  },
  timeout,
);

for (const route of ["claim", "renew", "release"] as const) {
  test(
    `owner ${route} refuses a stored v3 root before any SQL or alarm write`,
    async () => {
      const f = guardFixture();
      try {
        expect((await f.send(probe, {})).status).toBe(200);
        const effects = f.observeEffects();
        f.restart(false);
        const { status, body } = await f.send(
          route,
          {
            subject: "fixture",
            requestId: `owner-${route}`,
            generation: 1,
            ttlMs: 60_000,
            holder: {
              actor: { kind: "agent", id: "fixture" },
              session: { id: "fixture", device: "owner-fixture" },
            },
          },
          {
            "X-Forge-Owner": "owner-fixture",
            "X-Forge-Owner-Expires": String(Date.now() + 600_000),
          },
        );
        const code =
          isObject(body) && isObject(body.error) ? body.error.code : undefined;
        expect({ status, code, ...effects() }).toEqual({
          status: 409,
          code: "INPUT_CONFLICT",
          ...noWrites,
        });
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

test(
  "ordinary rehearsal provisioning still writes v2 and the public Worker cannot forward the probe",
  async () => {
    const f = fixture();
    try {
      f.restart(false);
      expect(
        (await f.send("devices", { device: "fixture", ttlMs: 60_000 })).status,
      ).toBe(200);
      expect(await f.send("dump")).toMatchObject({
        status: 200,
        body: { ok: true, value: { format: "forge-cloud-dump/2" } },
      });
      expect(await f.send("upgrade")).toMatchObject({
        status: 200,
        body: { ok: true, value: { ready: true, pending: [] } },
      });
      expect(
        f.db
          .query("SELECT name FROM sqlite_schema WHERE name LIKE 'cloud_v3_%'")
          .all(),
      ).toEqual([]);
      const response = await createWorker().fetch(f.request(probe, {}), {
        PROJECTS: {
          idFromName: () => {
            throw new Error("The public Worker resolved the private probe");
          },
          get: () => {
            throw new Error("The public Worker opened the private probe");
          },
        },
      });
      expect(response.status).toBe(404);
    } finally {
      f.db.close();
    }
  },
  timeout,
);
