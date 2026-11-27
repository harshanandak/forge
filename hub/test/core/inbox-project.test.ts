import { expect, test } from "bun:test";
import {
  ChatWriteFailure,
  type ChatMessageRef,
} from "../../src/contract/chat.ts";
import { createCli } from "../../src/core/cli.ts";
import { insertItem } from "../../src/core/routing.ts";
import { createStop } from "../../src/core/stop.ts";
import { baseFixture, type BaseFixture } from "./base-fixture.ts";
import { refusal } from "./base-fakes.ts";
import { a, b, p1, p2, seedItem, value } from "./fixture.ts";

const timeout = 30_000;

function refuseBinding(f: BaseFixture, sessionId: string) {
  const snapshot = () =>
    ["sessions", "inbox_items", "reply_owed", "meta", "thread_messages"].map(
      (table) => f.rows(table),
    );
  const before = snapshot();
  f.advance(1);
  const result = f.core.hello(f.caller(), {
    sessionId,
    projectId: p2,
    host: "claude",
  });
  const error = refusal(result);
  expect(error).toMatchObject({ code: "INPUT_INVALID", pointer: "/projectId" });
  expect(error.message).toContain("open a fresh session");
  expect(snapshot()).toEqual(before);
}

async function owedChat(f: BaseFixture, sessionId: string) {
  await f.emit("Project one task");
  const [item] = f.read(sessionId).items;
  if (!item) throw new Error("Expected project one chat delivery");
  expect(f.ack(sessionId, [item.itemId]).items).toEqual([]);
  expect(f.col("reply_owed", "answered")).toEqual([0]);
}

test(
  "Acknowledged chat still blocks a conflicting bind while its reply is owed",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    await owedChat(f, sessionId);
    refuseBinding(f, sessionId);
    const reply = createStop(f.context, f.core.reply);
    expect(
      value(
        await reply(
          { person: a, hostInstanceId: "hst_" + a.personId },
          {
            host: "claude",
            hostSessionId: "bound-a",
            text: "Finished the work",
          },
        ),
      ),
    ).toEqual({ result: "posted" });
    refuseBinding(f, sessionId);
    seedItem(f.db, "itm_legacy", { target: sessionId });
    f.db
      .prepare("UPDATE sessions SET project_id = ? WHERE session_id = ?")
      .run(p2, sessionId);
    f.unbound({ sessionId });
    expect(
      f.col("inbox_items WHERE item_id = 'itm_legacy'", "target_session_id"),
    ).toEqual([sessionId]);
  },
  timeout,
);

test(
  "A claimed Stop keeps its original obligation across a refused bind and Slack failure",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    await owedChat(f, sessionId);
    const claimed = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const posting = Promise.withResolvers<ChatMessageRef>();
    const write = f.chat.postText.bind(f.chat);
    f.chat.postText = () => {
      started.resolve();
      return posting.promise;
    };
    const stop = createStop(f.context, async (caller, input) => {
      await claimed.promise;
      return f.core.reply(caller, input);
    });
    const host = { person: a, hostInstanceId: "hst_" + a.personId };
    const input = {
      host: "claude",
      hostSessionId: "bound-a",
      text: "Finished the work",
    } as const;
    const inFlight = stop(host, input);
    try {
      expect(f.col("reply_owed", "answered")).toEqual([1]);
      refuseBinding(f, sessionId);
      claimed.resolve();
      await Promise.race([
        started.promise,
        inFlight.then(() => {
          throw new Error("Expected a pending Slack post");
        }),
      ]);
      refuseBinding(f, sessionId);
    } finally {
      claimed.resolve();
      f.chat.postText = write;
      posting.reject(new ChatWriteFailure("refused"));
      void posting.promise.catch(() => undefined);
    }
    expect(refusal(await inFlight).retry).toBe("safe");
    expect(f.rows("reply_owed", "session_id, answered")).toEqual([
      { session_id: sessionId, answered: 0 },
    ]);
    expect(value(await stop(host, input))).toEqual({ result: "posted" });
  },
  timeout,
);

test(
  "Reserved and unconfirmed posts block a bind without an item or reply obligation",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.unbound();
    await f.emit("Project one task");
    const [conversationId] = f.col("conversations", "conversation_id");
    if (typeof conversationId !== "string")
      throw new Error("Expected a conversation");
    const posted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = f.chat.postText.bind(f.chat);
    f.chat.postText = (...args) => {
      posted.resolve();
      return write(...args);
    };
    f.chat.nextWrite = { kind: "unknown", until: release.promise };
    const inFlight = f.core.reply(f.caller(), {
      sessionId,
      conversationId,
      text: "Working on the task",
    });
    try {
      await Promise.race([
        posted.promise,
        inFlight.then(() => {
          throw new Error("Expected a reserved post");
        }),
      ]);
      expect(f.rows("reply_owed")).toEqual([]);
      refuseBinding(f, sessionId);
    } finally {
      release.resolve();
    }
    expect(refusal(await inFlight).retry).toBe("reconcile_first");
    refuseBinding(f, sessionId);
    seedItem(f.db, "itm_uncertain", { target: sessionId });
    f.db
      .prepare("UPDATE sessions SET project_id = ? WHERE session_id = ?")
      .run(p2, sessionId);
    f.unbound({ sessionId });
    expect(
      f.col("inbox_items WHERE item_id = 'itm_uncertain'", "target_session_id"),
    ).toEqual([sessionId]);
  },
  timeout,
);

test(
  "CLI send leaves an item in its project queue when the front session is projectless",
  async () => {
    const f = await baseFixture();
    const cli = createCli(f.context);
    f.bind();
    const { itemId } = value(
      await cli.cliSend(b, {
        sessionId: f.unbound({ projectId: p1 }, b).sessionId,
        projectId: p1,
        toPersonId: a.personId,
        text: "Queued CLI message",
      }),
    );
    expect(value(cli.cliInbox(a, { projectId: p1 })).items).toMatchObject([
      { itemId, projectId: p1 },
    ]);
  },
  timeout,
);

test.each([false, true])(
  "Conflicting binding preserves the targeted item (previously delivered: %s)",
  async (delivered) => {
    const f = await baseFixture();
    const { sessionId } = f.unbound();
    const { itemId } = value(
      await f.core.send(f.caller(b), {
        sessionId: f.unbound({ projectId: p1 }, b).sessionId,
        targetSessionId: sessionId,
        toPersonId: a.personId,
        projectId: p1,
        text: "Project one message",
      }),
    );
    if (delivered)
      f.expectItems(sessionId, [{ itemId, projectId: p1, redelivered: false }]);

    refuseBinding(f, sessionId);
    expect(f.read(f.unbound({ projectId: p2 }).sessionId).items).toEqual([]);
    f.bindProject(sessionId, p1);
    f.expectItems(sessionId, [
      {
        itemId,
        projectId: p1,
        redelivered: delivered,
        text: "Project one message",
      },
    ]);
    expect(f.ack(sessionId, [itemId]).items).toEqual([]);
  },
  timeout,
);

test(
  "A target selected before binding stays recoverable in the source project",
  async () => {
    const f = await baseFixture();
    const target = f.context.store.sessions.createUnboundSession(
      a,
      undefined,
      "claude",
    );
    f.bindProject(target.sessionId, p2);
    const item = f.context.store.tx(() =>
      insertItem(f.context, {
        owner: a,
        sender: b,
        projectId: p1,
        target,
        text: "In-flight message",
      }),
    );
    const original = f.unbound({ projectId: p1 }).sessionId;
    expect({
      target: item.session,
      items: f.read(original).items.map((entry) => entry.itemId),
    }).toEqual({ target: undefined, items: [item.id] });
  },
  timeout,
);

test.each([false, true])(
  "A same-project item delivers and acknowledges normally (initially scoped: %s)",
  async (scoped) => {
    const f = await baseFixture();
    const { sessionId } = f.unbound(scoped ? { projectId: p1 } : {});
    const itemId = "itm_same_project";
    seedItem(f.db, itemId, { target: sessionId });
    if (!scoped) expect(f.bindProject(sessionId, p1).unread).toBe(1);
    f.expectItems(sessionId, [{ itemId, projectId: p1, redelivered: false }]);
    f.expectItems(sessionId, [{ itemId, projectId: p1, redelivered: true }]);
    expect(f.ack(sessionId, [itemId]).items).toEqual([]);
  },
  timeout,
);

test(
  "An already-scoped session cannot deliver or acknowledge legacy mismatches",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.unbound({ projectId: p2 });
    seedItem(f.db, "itm_pending", { target: sessionId });
    seedItem(f.db, "itm_delivered", {
      target: sessionId,
      delivered: sessionId,
    });
    const before = f.read(sessionId);
    const ack = f.core.inbox(f.caller(), {
      sessionId,
      ackItemIds: ["itm_delivered"],
    });
    f.unbound({ sessionId });
    const recovered = f.read(f.unbound({ projectId: p1 }).sessionId);
    expect({
      before: before.items.map((item) => item.itemId),
      ack: ack.ok ? "accepted" : ack.error.code,
      recovered: recovered.items.map((item) => item.itemId),
    }).toEqual({
      before: [],
      ack: "ACK_INVALID",
      recovered: ["itm_delivered", "itm_pending"],
    });
  },
  timeout,
);
