import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { storageOf } from "../../cloud/conformance/storage.ts";
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

const env = {
  FORGE_CLOUD_PROJECT: "p",
  FORGE_CLOUD_ID_PREFIX: "forge",
  GITHUB_REPOSITORY: "acme/forge",
  ADMIN_TOKEN: "fixture-admin",
};
const actor = { kind: "agent", id: "builder" };
const session = { id: "session-1" };

async function withProject(
  check: (fixture: {
    db: Database;
    restart: () => void;
    command: (
      requestId: string,
      op: string,
      input: object,
      context?: object,
    ) => Promise<Response>;
  }) => Promise<void>,
) {
  const db = new Database(":memory:");
  try {
    const { storage } = storageOf(db);
    let project = new Project({ storage }, env);
    const worker = createWorker();
    const bindings = {
      ...env,
      PROJECTS: { idFromName: (name: string) => name, get: () => project },
    };
    const post = (route: string, token: string, body: unknown) =>
      worker.fetch(
        new Request(`https://forge.test/p/p/${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
        bindings,
      );
    const issued = await post("devices", env.ADMIN_TOKEN, {
      device: "laptop",
      ttlMs: 600_000,
    });
    expect(issued.status).toBe(200);
    const { value } = (await issued.json()) as { value: { token: string } };
    await check({
      db,
      restart: () => {
        project = new Project({ storage }, env);
      },
      command: (requestId, op, input, context = { actor }) =>
        post("command", value.token, { requestId, op, input, context }),
    });
  } finally {
    db.close();
  }
}

test("a PR close without a delivers link gives a stable wire reason", async () => {
  await withProject(async ({ command }) => {
    const id = "forge-1";
    expect(
      (await command("create", "issue.create", { title: "First" })).status,
    ).toBe(200);
    expect(
      (await command("claim", "issue.claim", { id }, { actor, session }))
        .status,
    ).toBe(200);
    const response = await command(
      "close",
      "issue.close",
      { id, pr: 490 },
      { actor, session, leaseGeneration: 1 },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      status: "FAIL",
      error: {
        code: "INPUT_INVALID",
        message: "Newest delivery must name the admitted repository and PR",
        retry: "never",
      },
      warnings: [],
    });
    expect(body).toHaveProperty("error.reasonId", "receipt.delivery_mismatch");
  });
}, 10_000);

test("an unregistered user table gives a stable wire reason", async () => {
  await withProject(async ({ db, restart, command }) => {
    db.run("CREATE TABLE xcf_METADATA (key TEXT PRIMARY KEY)");
    restart();
    const response = await command("create", "issue.create", {
      title: "First",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      status: "FAIL",
      error: {
        code: "INPUT_INVALID",
        message: "Unregistered user table: xcf_METADATA",
        retry: "never",
      },
      warnings: [],
    });
    expect(body).toHaveProperty("error.reasonId", "store.unregistered_table");
  });
}, 10_000);
