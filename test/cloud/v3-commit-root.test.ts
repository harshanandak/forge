import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { browserStorage } from "./browser-storage.fixture.ts";

const timeout = 30_000;
const probe = "test-v3";
const format = "forge-cloud-root/3";
const frames = [
  {
    operation: "fixture.put",
    time: 1000,
    events: [{ key: "a" }, { key: "b" }],
  },
  { operation: "fixture.refuse", time: 1001, events: [] },
  { operation: "fixture.delete", time: 1002, events: [{ key: "a" }] },
] as const;

function fixture() {
  const db = new Database(":memory:");
  const { storage, values } = browserStorage(db);
  const context = { storage, testV3: true };
  let project = new Project(context);
  const request = (route: string, body?: unknown) =>
    new Request(`https://fixture.example/p/a/${route}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    db,
    values,
    request,
    restart: (testV3 = true) => {
      project = new Project(testV3 ? context : { storage });
    },
    send: async (route: string, body?: unknown) => {
      const response = await project.fetch(request(route, body));
      return {
        status: response.status,
        body: await response.json(),
      };
    },
    snapshot: () => ({ sql: db.serialize(), kv: [...values] }),
  };
}

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

const corruptions = [
  ["missing page", "DELETE FROM cloud_v3_pages WHERE id='directory:0'"],
  [
    "extra page",
    "INSERT INTO cloud_v3_pages (id, body) SELECT 'foreign:0', body FROM cloud_v3_pages WHERE id='directory:0'",
  ],
  [
    "reordered roster",
    "UPDATE cloud_v3_root SET body=json_set(body,'$.pages',json_array(json_extract(body,'$.pages[1]'),json_extract(body,'$.pages[0]')))",
  ],
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

test(
  "the same commits store identical ordered frame bytes, including a zero-event frame",
  async () => {
    const read = async () => {
      const f = fixture();
      try {
        const provisioned = await f.send(probe, {});
        const appended = await f.send(`${probe}/commits`, { frames });
        expect(appended.status).toBe(200);
        expect(provisioned.status).toBe(200);
        f.restart();
        return f.db
          .query(
            "SELECT sequence, body FROM cloud_v3_commits ORDER BY sequence",
          )
          .all();
      } finally {
        f.db.close();
      }
    };
    const expected = frames.map((frame, i) => ({
      sequence: i + 1,
      body: canonicalJson({
        ...frame,
        format: "forge-cloud-commit/3",
        sequence: i + 1,
      }),
    }));
    expect(await read()).toEqual(expected);
    expect(await read()).toEqual(expected);
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
