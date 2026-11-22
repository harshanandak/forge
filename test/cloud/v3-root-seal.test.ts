import { expect, test } from "bun:test";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import {
  copyTables,
  guardFixture,
  newKey,
  noWrites,
  probe,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const refused = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
};
const note = { operation: "fixture.note", time: 1, events: [] };

type Fixture = ReturnType<typeof guardFixture>;

async function checkpointed(f: Fixture) {
  expect((await f.send(probe, {})).status).toBe(200);
  for (let i = 0; i < 2; i++)
    expect((await f.send(`${probe}/commits`, { frames: [note] })).status).toBe(
      200,
    );
  expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject({
    status: 200,
    body: { value: { coveredHead: 2, more: false } },
  });
  expect(f.db.query("SELECT 1 FROM cloud_v3_commits").all()).toEqual([]);
}

test(
  "v3 refuses a coherent root edit whose seal is recomputed as the plain digest",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await checkpointed(f);
    const { body } = f.db
      .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
      .get()!;
    const root = JSON.parse(body) as { eventWatermark: number };
    const edited = canonicalJson({
      ...root,
      eventWatermark: root.eventWatermark + 1,
    });
    f.db.run("UPDATE cloud_v3_root SET body=?, seal=?", [
      edited,
      digestBytes(edited),
    ]);
    f.restart();
    const effects = f.observeEffects();
    expect(await f.send(probe)).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test(
  "v3 refuses a whole sealed project with an empty tail copied into another object",
  async () => {
    const key = newKey();
    const source = guardFixture(env, { key });
    const target = guardFixture(env, { key });
    using _source = source.db;
    using _target = target.db;
    await checkpointed(source);
    expect((await target.send(probe, {})).status).toBe(200);
    copyTables(source, target);
    target.restart();
    const effects = target.observeEffects();
    expect(await target.send(probe)).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);
