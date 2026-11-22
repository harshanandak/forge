import { expect, test } from "bun:test";
import { Project } from "../../cloud/src/project.ts";
import { guardFixture, noWrites, probe } from "./v3-project.fixture.ts";

const timeout = 30_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };

test(
  "v3 provisioning with no seal key is refused as unavailable and writes nothing",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    const context = {
      storage: f.storage,
      testV3: true,
      id: { toString: () => "a".repeat(64) },
    };
    const effects = f.observeEffects();
    const response = await new Project(context, env).fetch(
      f.request(probe, {}),
    );
    expect({
      status: response.status,
      body: await response.json(),
    }).toMatchObject({
      status: 503,
      body: { ok: false, error: { code: "UNAVAILABLE" } },
    });
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);
