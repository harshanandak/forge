import { expect, test } from "bun:test";
import { ID_PATTERN } from "../../src/contract/ids.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import { baseFixture, bellFor } from "./base-fixture.ts";
import { until } from "./base-fakes.ts";
import { a, b, p1, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;

test(
  "DB1 send IDs only, debounce from rows, and suppress a ring for a pending wait",
  async () => {
    const f = await baseFixture({ ring: true });
    const { sessionId } = f.bind();
    await f.emit("first");
    await until(() => f.rings.length === 1, timeout);
    const first = f.read(sessionId).items[0]!;
    const ring = f.rings[0]!;
    expect(ring.ring).toMatch(ID_PATTERN);
    expect(ring.conversation).toMatch(ID_PATTERN);
    expect(ring).toEqual({
      v: 1,
      ring: ring.ring,
      person: a.personId,
      project: p1,
      session: sessionId,
      conversation: ring.conversation!,
      items: [first.itemId],
      answers: [],
    });
    const fields = "ring_id,person_id,project_id,session_id,outcome";
    const rows = f.rows("doorbell_rings", fields);
    expect(rows).toEqual([
      {
        ring_id: ring.ring,
        person_id: a.personId,
        project_id: p1,
        session_id: sessionId,
        outcome: "sent",
      },
    ]);
    f.advance(LIMITS.doorbellDebounceMs - 1);
    await f.emit("inside-debounce", { threadRootMessageId: "first" });
    const itemIds = f.read(sessionId).items.map((item) => item.itemId);
    f.ack(sessionId, itemIds);
    f.advance(LIMITS.doorbellDebounceMs);
    const waiting = f.wait(sessionId, 20_000);
    await f.emit("with-waiter", { threadRootMessageId: "first" });
    expect(value(await waiting)).toMatchObject({
      status: "ready",
      items: [{ text: "with-waiter" }],
    });
    expect(f.rings).toHaveLength(1);
    expect(f.rows("doorbell_rings", fields)).toEqual(rows);
  },
  timeout,
);

test(
  "DB2 queue notice names an offline recipient once per conversation",
  async () => {
    const f = await baseFixture();
    await f.dm("queued-first", "First", slackB);
    await f.dm("queued-second", "Second", slackB, "queued-first");
    expect(f.posts()).toEqual(["Queued for Fixture Beta's agent."]);
    expect(f.rows("conversations")).toHaveLength(1);
    expect(f.rows("inbox_items")).toHaveLength(2);
    expect(f.rings).toEqual([]);
  },
  timeout,
);

test(
  "B1B-DB1 targeted stale session notifies despite another live session",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const stale = f.bind(b, "stale", "beta");
    f.advance(1);
    f.bind(b, "live", "live-thread");
    f.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?")
      .run(f.now() - LIMITS.liveSessionMs - 1, stale.sessionId);
    await f.emit("b1b-stale", { mentionedSlackUserIds: [slackB] });
    expect(f.rows("inbox_items", "target_session_id")).toEqual([
      { target_session_id: stale.sessionId },
    ]);
    expect(f.posts()).toEqual([
      "Queued for Fixture Beta's agent. It is offline and will see this when it reconnects.",
    ]);
  },
  timeout,
);

test(
  "B1B-DB2 targeted live session produces no notice",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const live = f.bind(b, "live", "beta");
    await f.emit("b1b-live", { mentionedSlackUserIds: [slackB] });
    expect(f.rows("inbox_items", "target_session_id")).toEqual([
      { target_session_id: live.sessionId },
    ]);
    expect(f.posts()).toEqual([]);
  },
  timeout,
);

test(
  "B1B-DB3 untargeted item with a live session produces no notice",
  async () => {
    const f = await baseFixture();
    f.bind(b, "live", "live-thread");
    await f.dm("b1b-untargeted", "Help", slackB);
    expect(f.rows("inbox_items", "target_session_id")).toEqual([
      { target_session_id: null },
    ]);
    expect(f.posts()).toEqual([]);
  },
  timeout,
);

test(
  "B1B-DB4 second targeted-stale item within the hour adds no notice",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const stale = f.bind(b, "stale", "beta");
    f.advance(1);
    f.bind(b, "live", "live-thread");
    f.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?")
      .run(f.now() - LIMITS.liveSessionMs - 1, stale.sessionId);
    await f.emit("b1b-first", { mentionedSlackUserIds: [slackB] });
    const afterFirst = f.posts().length;
    await f.emit("b1b-second", { mentionedSlackUserIds: [slackB] });
    expect(f.rows("inbox_items")).toHaveLength(2);
    expect(f.posts()).toHaveLength(afterFirst);
  },
  timeout,
);
