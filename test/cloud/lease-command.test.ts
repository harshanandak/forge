import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Project } from "../../cloud/src/project.ts";
import { browserStorage } from "./browser-storage.fixture.ts";

const timeout = 30_000;
const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};

afterEach(() => setSystemTime());

test(
  "a v2 retry of a recorded ttl refusal returns that refusal before the subject is read",
  async () => {
    setSystemTime(T0);
    const db = new Database(":memory:");
    try {
      const { storage } = browserStorage(db);
      const claim = async () => {
        const response = await new Project({ storage }).fetch(
          new Request("https://fixture.example/p/a/claim", {
            method: "POST",
            headers: {
              "X-Forge-Owner": "owner-a",
              "X-Forge-Owner-Expires": String(T0 + 60 * 60_000),
            },
            body: JSON.stringify({
              subject: "w".repeat(501),
              requestId: "acq-1",
              holder,
              ttlMs: 0,
            }),
          }),
        );
        return { status: response.status, body: await response.json() };
      };
      const first = await claim();
      expect(first).toMatchObject({
        status: 400,
        body: {
          ok: false,
          error: {
            code: "INPUT_INVALID",
            message: "ttlMs must be a positive safe integer",
          },
        },
      });
      expect(await claim()).toEqual(first);
    } finally {
      db.close();
    }
  },
  timeout,
);
