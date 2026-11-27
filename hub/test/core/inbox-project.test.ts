import { expect, test } from "bun:test";
import { createCli } from "../../src/core/cli.ts";
import { insertItem } from "../../src/core/routing.ts";
import { createStop } from "../../src/core/stop.ts";
import { baseFixture, seedThread } from "./base-fixture.ts";
import { a, b, p1, p2, seedItem, value } from "./fixture.ts";

const timeout = 30_000;

test(
  "A requeued chat item keeps its thread context and moves its reply obligation",
  async () => {
    const f = await baseFixture();
    const hostSessionId = "scoped-chat";
    const { sessionId } = f.bind(a, hostSessionId);
    seedThread(f, "early", "Earlier reply", "person", b.personId);
    await f.emit("current");
    const [item] = f.read(sessionId).items;
    if (!item) throw new Error("Expected project one chat delivery");
    expect(item.threadContext?.entries).toMatchObject([
      { text: "Earlier reply" },
    ]);
    f.bindProject(sessionId, p2);
    const stopped = await createStop(f.context, f.core.reply)(
      { person: a, hostInstanceId: "hst_" + a.personId },
      { host: "claude", hostSessionId, text: "Finished the work" },
    );
    expect(value(stopped)).toEqual({ result: "skipped" });
    const original = f.unbound({ projectId: p1 }).sessionId;
    expect(f.read(original).items).toMatchObject([
      {
        itemId: item.itemId,
        redelivered: false,
        threadContext: item.threadContext,
      },
    ]);
    expect(f.col("reply_owed", "session_id")).toEqual([original]);
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
  "Binding to another project requeues a targeted item (previously delivered: %s)",
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

    const hello = f.bindProject(sessionId, p2);
    const other = f.read(sessionId);
    const ack = f.core.inbox(f.caller(), { sessionId, ackItemIds: [itemId] });
    const original = f.unbound({ projectId: p1 }).sessionId;
    const recovered = f.read(original);
    expect({
      unread: hello.unread,
      otherItems: other.items.map((item) => item.itemId),
      ack: ack.ok ? "accepted" : ack.error.code,
      recovered: recovered.items.map((item) => ({
        itemId: item.itemId,
        projectId: item.projectId,
        redelivered: item.redelivered,
        text: item.text,
      })),
    }).toEqual({
      unread: 0,
      otherItems: [],
      ack: "ACK_INVALID",
      recovered: [
        {
          itemId,
          projectId: p1,
          redelivered: false,
          text: "Project one message",
        },
      ],
    });
    expect(f.ack(original, [itemId]).items).toEqual([]);
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
