import { expect, test } from "bun:test";
import {
  baseFixture,
  channel,
  seedThread,
  thread,
  unknownUser,
} from "./base-fixture.ts";
import { slackB } from "./fakes.ts";
import { b } from "./fixture.ts";

const timeout = 30_000;

test(
  "TH3 edits stay in thread history and deletes disappear from context",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    await f.emit("initial");
    const first = f.read(sessionId).items[0]!;
    f.ack(sessionId, [first.itemId]);
    const member = {
      slackUserId: slackB,
      mentionsBot: false,
      threadRootMessageId: "initial",
    };
    seedThread(f, "edited", "Original", "person", b.personId);
    seedThread(f, "deleted", "Delete me", "person", b.personId);
    const change = (
      chatMessageId: string,
      text: string,
      kind: "edited" | "deleted" = "edited",
    ) =>
      f.chat.emitMessageChange({
        channelId: channel,
        chatThreadId: thread,
        chatMessageId,
        kind,
        text,
        fileNames: [],
      });
    await change("edited", "first edit");
    const editedAt = f.now();
    f.advance(10);
    await change("deleted", "", "deleted");
    await f.emit("target", member);
    const target = () =>
      f.read(sessionId).items.find((item) => item.text === "target")!;
    expect(target().threadContext?.entries.map((row) => row.text)).toEqual([
      "first edit",
    ]);
    expect(
      f.rows(
        "thread_messages WHERE chat_message_id = 'edited'",
        "edited_at,deleted,text",
      ),
    ).toEqual([{ edited_at: editedAt, deleted: 0, text: "first edit" }]);
    expect(
      f.rows(
        "thread_messages WHERE chat_message_id = 'deleted'",
        "deleted,text",
      ),
    ).toEqual([{ deleted: 1, text: "" }]);
    await change("edited", "second edit");
    await change("target", "target edited later");
    const again = target();
    expect(again.redelivered).toBe(true);
    expect(again.text).toBe("target");
    expect(again.threadContext?.entries.map((row) => row.text)).toEqual([
      "second edit",
    ]);
    await f.emit("outsider", { ...member, slackUserId: unknownUser });
    const all = f.rows("thread_messages");
    await change("missing", "unknown content");
    await change("outsider", "outsider content");
    expect(f.rows("thread_messages")).toEqual(all);
  },
  timeout,
);

test(
  "TH4 outsider content never enters storage, logs or context",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    await f.emit("root");
    const outside = "Outsider text should never be retained";
    await f.emit("outside", {
      slackUserId: unknownUser,
      mentionsBot: false,
      threadRootMessageId: "root",
      text: outside,
    });
    await f.follow("next");
    const inbox = f.read(sessionId).items;
    expect(inbox.map((item) => item.text).sort()).toEqual(["next", "root"]);
    expect(inbox).toHaveLength(2);
    const context = inbox.find((item) => item.text === "next")?.threadContext;
    expect(
      context?.entries.find((entry) => entry.senderKind === "outsider"),
    ).toMatchObject({
      from: "a person outside Forge",
      senderKind: "outsider",
      text: "",
      notYourOwner: true,
    });
    expect(
      f.rows("thread_messages WHERE chat_message_id = 'outside'", "kind,text"),
    ).toEqual([{ kind: "outsider", text: "" }]);
    for (const table of ["thread_messages", "inbox_items"])
      expect(JSON.stringify(f.sql("SELECT * FROM " + table))).not.toContain(
        outside,
      );
    expect(JSON.stringify(f.logged)).not.toContain(outside);
  },
  timeout,
);
