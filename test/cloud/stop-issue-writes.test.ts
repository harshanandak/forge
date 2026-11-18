import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { storageOf } from "../../cloud/conformance/storage.ts";
import { DUMP, type Tables } from "../../cloud/conformance/max-source.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

const admin = "admin-secret";
const actor = { kind: "agent", id: "fixture" } as const;
const session = { id: "s1" };

function project(name: string) {
  const db = new Database(":memory:");
  const env = {
    FORGE_CLOUD_PROJECT: name,
    ADMIN_TOKEN: admin,
    FORGE_CLOUD_ID_PREFIX: "forge",
  };
  const object = new Project({ storage: storageOf(db).storage }, env);
  const bindings = {
    ...env,
    PROJECTS: { idFromName: (id: string) => id, get: () => object },
  };
  const route = async (path: string, token: string, body?: unknown) => {
    const response = await createWorker().fetch(
      new Request(`https://w.example/p/${name}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      bindings,
    );
    return {
      status: response.status,
      json: (await response.json()) as {
        ok: boolean;
        result?: Record<string, unknown>;
        value?: { token: string; tables: Tables };
        error?: { code: string };
      },
    };
  };
  const device = async () =>
    (
      await route("devices", admin, {
        device: "laptop",
        session: session.id,
        ttlMs: 86_400_000,
      })
    ).json.value!.token;
  return { db, route, device };
}

test("after a restore stops every lane, issue create, comment, claim and close still succeed", async () => {
  const source = project("p");
  const target = project("p");
  try {
    const sourceToken = await source.device();
    let sequence = 0;
    const command = (
      token: string,
      op: string,
      input: object,
      context: object = { actor, session },
    ) =>
      source.route("command", token, {
        requestId: `seed-${++sequence}`,
        op,
        input,
        context,
      });
    const seeded = await command(sourceToken, "issue.create", {
      title: "Seed",
    });
    expect(seeded.json.ok).toBe(true);
    const id = seeded.json.result!.id as string;

    const tables = (await source.route("dump", admin)).json.value!.tables;
    const restored = await target.route("restore", admin, {
      format: DUMP,
      tables,
    });
    expect(restored.status).toBe(200);

    const token = await target.device();
    const send = (op: string, input: object, context: object) =>
      target.route("command", token, {
        requestId: `after-${++sequence}`,
        op,
        input,
        context,
      });
    const control = async () =>
      (await send("lane.control", {}, { actor })).json.result;
    expect(await control()).toMatchObject({ stopped: true, scope: "all" });

    const created = await send(
      "issue.create",
      { title: "After" },
      {
        actor,
        session,
      },
    );
    const commented = await send(
      "issue.comment",
      { id, body: "After restore" },
      { actor, session },
    );
    const claimed = await send(
      "issue.claim",
      { id, ttlSeconds: 60 },
      { actor, session },
    );
    const closed = await send(
      "issue.close",
      { id, withoutReceipt: "Synthetic proof" },
      { actor, session, leaseGeneration: claimed.json.result?.generation },
    );

    expect(
      [created, commented, claimed, closed].map((reply) => [
        reply.status,
        reply.json.ok,
        reply.json.error?.code,
      ]),
    ).toEqual(Array.from({ length: 4 }, () => [200, true, undefined]));
    expect(closed.json.result).toMatchObject({ id, status: "closed" });
    expect(await control()).toMatchObject({ stopped: true, scope: "all" });
  } finally {
    source.db.close();
    target.db.close();
  }
}, 30_000);
