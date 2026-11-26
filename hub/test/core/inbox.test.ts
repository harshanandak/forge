import { expect, test } from "bun:test";
import { baseFixture } from "./base-fixture.ts";
import { refusal, until } from "./base-fakes.ts";
import { a, b, p1, p2, seedItem, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;

test(
  "J1 an unacknowledged item redelivers without another mode flip",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    seedItem(f.db, "itm_dropped");
    f.expectItems(sessionId, [{ itemId: "itm_dropped", redelivered: false }]);
    const before = f.rows("inbox_items", "delivered_at");
    f.advance(100);
    f.expectItems(sessionId, [{ itemId: "itm_dropped", redelivered: true }]);
    expect(f.rows("inbox_items", "delivered_at")).toEqual(before);
    expect(f.col("sessions", "untrusted_read_seq")).toEqual([1]);
  },
  timeout,
);

test(
  "J2 one invalid acknowledgement rolls back all acknowledgements",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    seedItem(f.db, "itm_ours", { delivered: sessionId });
    seedItem(f.db, "itm_elsewhere", {
      delivered: f.bind(a, "second").sessionId,
    });
    const result = f.core.inbox(f.caller(), {
      sessionId,
      ackItemIds: ["itm_ours", "itm_elsewhere"],
    });
    expect(refusal(result).code).toBe("ACK_INVALID");
    expect(f.col("inbox_items", "acked_at")).toEqual([null, null]);
  },
  timeout,
);

test(
  "J3 item and ask acknowledgements persist once",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    const { askId } = await f.choice(sessionId);
    await f.action(askId, "ack-answer");
    await until(() => f.kicks() === 1, timeout);
    seedItem(f.db, "itm_ack", { delivered: sessionId });
    expect(f.read(sessionId).answers).toMatchObject([{ askId }]);
    const ack = value(
      f.core.inbox(f.caller(), {
        sessionId,
        ackItemIds: ["itm_ack"],
        ackAskIds: [askId],
      }),
    );
    expect(ack).toMatchObject({ items: [], answers: [] });
    f.advance(50);
    expect(f.read(sessionId)).toMatchObject({ items: [], answers: [] });
    for (const table of ["inbox_items", "ask_answers"])
      expect(f.sql("SELECT acked_at FROM " + table)).toEqual([
        { acked_at: f.now() - 50 },
      ]);
  },
  timeout,
);

test(
  "B1B-ACK1 answer acknowledgement requires delivery first",
  async () => {
    const prematureFixture = await baseFixture();
    const prematureSession = prematureFixture.bind();
    const prematureAsk = await prematureFixture.choice(
      prematureSession.sessionId,
    );
    await prematureFixture.action(prematureAsk.askId, "ack-before-delivery");
    const premature = prematureFixture.core.inbox(prematureFixture.caller(), {
      sessionId: prematureSession.sessionId,
      ackAskIds: [prematureAsk.askId],
    });

    const mixedFixture = await baseFixture();
    const mixedSession = mixedFixture.bind();
    const mixedAsk = await mixedFixture.choice(mixedSession.sessionId);
    await mixedFixture.action(mixedAsk.askId, "ack-mixed-undelivered");
    seedItem(mixedFixture.db, "itm_ack_valid", {
      delivered: mixedSession.sessionId,
    });
    const mixed = mixedFixture.core.inbox(mixedFixture.caller(), {
      sessionId: mixedSession.sessionId,
      ackItemIds: ["itm_ack_valid"],
      ackAskIds: [mixedAsk.askId],
    });

    expect(
      [premature, mixed].map((result) =>
        result.ok ? "accepted" : result.error.code,
      ),
    ).toEqual(["ACK_INVALID", "ACK_INVALID"]);
    expect(prematureFixture.col("ask_answers", "acked_at")).toEqual([null]);
    expect(mixedFixture.col("ask_answers", "acked_at")).toEqual([null]);
    expect(
      mixedFixture.col(
        "inbox_items WHERE item_id = 'itm_ack_valid'",
        "acked_at",
      ),
    ).toEqual([null]);

    const delivered = mixedFixture.read(mixedSession.sessionId);
    expect(delivered.answers.map((answer) => answer.askId)).toEqual([
      mixedAsk.askId,
    ]);
    expect(mixedFixture.col("ask_answers", "delivered_at")).toEqual([
      mixedFixture.now(),
    ]);
    const ack = value(
      mixedFixture.core.inbox(mixedFixture.caller(), {
        sessionId: mixedSession.sessionId,
        ackItemIds: ["itm_ack_valid"],
        ackAskIds: [mixedAsk.askId],
      }),
    );
    expect(ack).toMatchObject({ items: [], answers: [] });
    expect(mixedFixture.read(mixedSession.sessionId)).toMatchObject({
      items: [],
      answers: [],
    });
  },
  timeout,
);

test(
  "J4 assigning an untrusted item flips its child and ancestors only once",
  async () => {
    const f = await baseFixture();
    const parent = f.bind();
    const child = f.unbound({
      parentSessionId: parent.sessionId,
      projectId: p1,
    });
    const sibling = f.bind(a, "sibling");
    seedItem(f.db, "itm_child", { target: child.sessionId });
    f.expectItems(child.sessionId, [
      { itemId: "itm_child", redelivered: false },
    ]);
    expect(value(await f.wait(child.sessionId))).toMatchObject({
      status: "ready",
      items: [{ itemId: "itm_child", redelivered: true }],
    });
    for (const sessionId of [parent.sessionId, child.sessionId])
      expect(
        f.rows(
          "sessions WHERE session_id = ?",
          "mode,mode_reason,untrusted_read_seq",
          sessionId,
        ),
      ).toEqual([
        {
          mode: "reply_only",
          mode_reason: "read_untrusted",
          untrusted_read_seq: 1,
        },
      ]);
    expect(
      f.rows(
        "sessions WHERE session_id = ?",
        "mode,untrusted_read_seq",
        sibling.sessionId,
      ),
    ).toEqual([{ mode: "normal", untrusted_read_seq: 0 }]);
  },
  timeout,
);

test(
  "PU1 channel and DM items carry the project and audience",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    const beta = f.bind(b);
    await f.emit("slack-channel");
    await f.dm("slack-dm", "DM", slackB);
    f.expectItems(alpha.sessionId, [
      {
        projectName: "Fixture One",
        projectPurpose: "Shared project context",
        audience: "channel",
      },
    ]);
    f.expectItems(
      beta.sessionId,
      [
        {
          projectName: "Fixture One",
          projectPurpose: "Shared project context",
          audience: "dm",
        },
      ],
      b,
    );
  },
  timeout,
);

test(
  "Project isolation filters untargeted items before the inbox limit",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    f.bindProject(sessionId);
    seedItem(f.db, "itm_01_other", { projectId: p2 });
    seedItem(f.db, "itm_02_own", { projectId: p1 });
    expect(
      value(f.core.inbox(f.caller(), { sessionId, limit: 1 })).items,
    ).toMatchObject([{ itemId: "itm_02_own", projectId: p1 }]);
    expect(
      f.col(
        "inbox_items WHERE item_id = 'itm_01_other'",
        "delivered_to_session_id",
      ),
    ).toEqual([null]);
    expect(f.read(f.bind(a, "without-project").sessionId).items).toMatchObject([
      { itemId: "itm_01_other", projectId: p2 },
    ]);
  },
  timeout,
);
