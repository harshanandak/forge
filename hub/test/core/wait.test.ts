import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import { createCoreContext } from "../../src/core/core.ts";
import { baseFixture } from "./base-fixture.ts";
import { refusal } from "./base-fakes.ts";
import { a, configPeople, openDb, seedItem, value } from "./fixture.ts";

const timeout = 30_000;

test(
  "W1 wait returns pending within the cap",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    const start = performance.now();
    expect(value(await f.wait(sessionId))).toMatchObject({
      status: "pending",
      items: [],
      answers: [],
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(3_000);
    expect(f.rows("inbox_items", "delivered_at")).toEqual([]);
  },
  timeout,
);

test(
  "W2 an inbound Slack message wakes wait and flips mode",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    const start = performance.now();
    const waiting = f.wait(sessionId, 20_000);
    await Bun.sleep(100);
    await f.emit("outside-owner", { slackUserId: "U00000002" });
    expect(value(await waiting)).toMatchObject({
      status: "ready",
      mode: "reply_only",
      items: [{ text: "outside-owner" }],
    });
    expect(performance.now() - start).toBeLessThan(1_000);
  },
  timeout,
);

test(
  "W3 a Slack answer wakes the asker and is assigned only once",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    const { askId } = await f.choice(sessionId);
    const waiting = f.wait(sessionId, 20_000);
    await f.action(askId, "wake-answer");
    expect(value(await waiting)).toMatchObject({
      status: "ready",
      answers: [{ askId, redelivered: false }],
    });
    const first = f.rows("ask_answers", "delivered_at");
    expect(first).toEqual([{ delivered_at: f.now() }]);
    f.advance(100);
    expect(f.read(sessionId).answers).toMatchObject([
      { askId, redelivered: true },
    ]);
    expect(f.rows("ask_answers", "delivered_at")).toEqual(first);
  },
  timeout,
);

test(
  "W4 abort returns pending promptly and invalid timeouts are refused",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    const stop = new AbortController();
    const waiting = f.wait(sessionId, 20_000, stop.signal);
    await Bun.sleep(100);
    const atAbort = performance.now();
    stop.abort();
    expect(value(await waiting)).toMatchObject({
      status: "pending",
      items: [],
      answers: [],
    });
    expect(performance.now() - atAbort).toBeLessThan(500);
    for (const milliseconds of [25_001, 999])
      expect(refusal(await f.wait(sessionId, milliseconds))).toMatchObject({
        code: "INPUT_INVALID",
        pointer: "/timeoutMs",
      });
    expect(f.rows("inbox_items")).toEqual([]);
  },
  timeout,
);

test(
  "W5 outstanding inbox items return immediately",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    seedItem(f.db, "itm_outstanding");
    expect(f.read(sessionId).items).toHaveLength(1);
    const start = performance.now();
    expect(value(await f.wait(sessionId, 20_000))).toMatchObject({
      status: "ready",
      items: [{ itemId: "itm_outstanding", redelivered: true }],
    });
    expect(performance.now() - start).toBeLessThan(200);
    expect(f.col("sessions", "untrusted_read_seq")).toEqual([1]);
  },
  timeout,
);

test(
  "W6 revocation or config removal through another handle stops a running wait",
  async () => {
    for (const removed of [false, true]) {
      const f = await baseFixture();
      const { sessionId } = f.bind();
      const { tokenId } = f.caller();
      const db = openDb(f.path);
      const started = performance.now();
      const waiting = f.wait(sessionId);
      await Bun.sleep(100);
      if (removed) {
        const people = f.config.people.filter(
          (person) => person.personId !== a.personId,
        );
        const projects = f.config.projects.map((project) => {
          const memberIds = project.memberIds.filter((id) => id !== a.personId);
          return { ...project, memberIds, frontPersonId: memberIds[0]! };
        });
        createCoreContext({
          ...f.deps,
          db,
          people: configPeople(people),
          config: { ...f.config, people, projects, doorbells: [] },
        });
        expect(
          f.col("tokens WHERE revoked_at IS NOT NULL", "token_id"),
        ).toEqual([tokenId]);
        expect(
          f.col("host_keys WHERE revoked_at IS NOT NULL", "person_id"),
        ).toEqual([a.personId]);
        seedItem(db, "itm_after_removal");
        db.exec("UPDATE inbox_items SET project_id = NULL");
      } else {
        const ctx = createCoreContext({ ...f.deps, db });
        expect(ctx.store.credentials.revokeToken(tokenId)).toBe(true);
        await f.emit("after-revocation", { slackUserId: "U00000002" });
      }
      expect(refusal(await waiting).code).toBe("UNAUTHENTICATED");
      expect(performance.now() - started).toBeLessThanOrEqual(LIMITS.waitMaxMs);
      expect(f.rows("inbox_items", "delivered_at,acked_at")).toEqual([
        { delivered_at: null, acked_at: null },
      ]);
      expect(f.rows("sessions", "mode,untrusted_read_seq")).toEqual([
        { mode: "normal", untrusted_read_seq: 0 },
      ]);
    }
  },
  timeout,
);
