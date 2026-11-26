import { expect, test } from "bun:test";
import { baseFixture } from "./base-fixture.ts";
import { refusal } from "./base-fakes.ts";
import { p1, value } from "./fixture.ts";

const timeout = 30_000;
const secondThread = "slack:C00000001:11.000001";

test(
  "B1B-OWED1 confirmed reply marks only that conversation's rows answered",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("c1-root");
    await f.emit("c2-root", { chatThreadId: secondThread });
    const items = f.read(alpha.sessionId).items;
    expect(items).toHaveLength(2);
    const first = items.find((item) => item.text === "c1-root");
    const second = items.find((item) => item.text === "c2-root");
    const c1 = first?.conversationId;
    const c2 = second?.conversationId;
    if (!c1 || !c2) throw new Error("Expected two Slack conversations");
    expect(c1).not.toBe(c2);
    value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        conversationId: c1,
        text: "Done C1",
      }),
    );
    const owed = (id: string) =>
      f.rows("reply_owed WHERE conversation_id = ?", "answered", id);
    expect(owed(c1)).toEqual([{ answered: 1 }]);
    expect(owed(c2)).toEqual([{ answered: 0 }]);
  },
  timeout,
);

test(
  "B1B-OWED1 refused and unknown posts leave every owed row unanswered",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("c1-root");
    await f.emit("c2-root", { chatThreadId: secondThread });
    const items = f.read(alpha.sessionId).items;
    const c1 = items.find((item) => item.text === "c1-root")?.conversationId;
    if (!c1) throw new Error("Expected a Slack conversation");
    const input = {
      sessionId: alpha.sessionId,
      conversationId: c1,
      text: "Done C1",
    };
    f.chat.nextWrite = { kind: "refused", reason: "not_in_channel" };
    expect(refusal(await f.core.reply(f.caller(), input))).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "safe",
    });
    expect(f.rows("reply_owed", "answered")).toEqual([
      { answered: 0 },
      { answered: 0 },
    ]);
    f.chat.nextWrite = { kind: "unknown" };
    expect(refusal(await f.core.reply(f.caller(), input))).toMatchObject({
      code: "CHAT_UNAVAILABLE",
      retry: "reconcile_first",
    });
    expect(f.rows("reply_owed", "answered")).toEqual([
      { answered: 0 },
      { answered: 0 },
    ]);
  },
  timeout,
);

test(
  "B1B-OWED1 project form leaves other conversations' rows unchanged",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("c1-root");
    await f.emit("c2-root", { chatThreadId: secondThread });
    expect(f.read(alpha.sessionId).items).toHaveLength(2);
    const before = f.rows(
      "reply_owed",
      "item_id,session_id,conversation_id,answered",
    );
    expect(before).toHaveLength(2);
    const out = value(
      await f.core.reply(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p1,
        text: "New thread",
      }),
    );
    expect(out.conversationId).toBeDefined();
    expect(
      f.rows("reply_owed", "item_id,session_id,conversation_id,answered"),
    ).toEqual(before);
  },
  timeout,
);
