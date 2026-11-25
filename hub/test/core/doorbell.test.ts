import { expect, test } from "bun:test";
import { ID_PATTERN } from "../../src/contract/ids.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import { baseFixture } from "./base-fixture.ts";
import { until } from "./base-fakes.ts";
import { a, p1, value } from "./fixture.ts";
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
