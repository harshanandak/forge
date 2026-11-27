import { expect, test } from "bun:test";
import { AGENT_MESSAGE_NOTICE, LIMITS } from "../../src/contract/mcp.ts";
import { ID_PATTERN } from "../../src/contract/ids.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { enterThread } from "../../src/core/thread.ts";
import {
  baseFixture,
  bellFor,
  channel,
  seedThread,
  thread,
} from "./base-fixture.ts";
import { refusal, until } from "./base-fakes.ts";
import { a, b, configPeople, p1, p2, value } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;
const c = { personId: "per_c", displayName: "Fixture Gamma" };
const draft = (sessionId: string) => ({
  sessionId,
  projectId: p1,
  toPersonId: b.personId,
  text: "Agent note",
});

test(
  "X1 private agent send wakes the recipient and labels the sender",
  async () => {
    const f = await baseFixture({ ring: true });
    const alpha = f.bind();
    const beta = f.bind(b);
    const { itemId } = value(
      await f.core.send(f.caller(), draft(alpha.sessionId)),
    );
    await until(() => f.rings.length > 0, timeout);
    const ring = f.rings[0]!.ring;
    expect(ring).toMatch(ID_PATTERN);
    expect(f.rings).toEqual([
      {
        v: 1,
        ring,
        person: b.personId,
        project: p1,
        items: [itemId],
        answers: [],
      },
    ]);
    expect(f.rows("inbox_items", "not_your_owner,conversation_id")).toEqual([
      { not_your_owner: 1, conversation_id: null },
    ]);
    expect(f.read(beta.sessionId, b)).toMatchObject({
      mode: "reply_only",
      items: [
        {
          itemId,
          trust: "agent",
          notice: AGENT_MESSAGE_NOTICE,
          from: {
            kind: "agent",
            name: a.displayName,
            personId: a.personId,
            sessionId: alpha.sessionId,
          },
        },
      ],
    });
    f.ack(beta.sessionId, [itemId], b);
    const waiting = f.wait(beta.sessionId, 20_000, undefined, b);
    const follow = value(await f.core.send(f.caller(), draft(alpha.sessionId)));
    expect(value(await waiting)).toMatchObject({
      status: "ready",
      items: [{ itemId: follow.itemId }],
    });
    expect(f.rows("conversations")).toEqual([]);
    expect(f.rings).toHaveLength(1);
  },
  timeout,
);

test(
  "X2 send requires both current project members",
  async () => {
    const f = await baseFixture({ ring: true });
    const alpha = f.bind();
    const gamma = f.bind(c);
    const note = draft(alpha.sessionId);
    for (const [sender, input, code] of [
      [a, { ...note, toPersonId: c.personId }, "NOT_PROJECT_MEMBER"],
      [c, draft(gamma.sessionId), "NOT_PROJECT_MEMBER"],
      [a, { ...note, toPersonId: "per_missing" }, "PERSON_UNKNOWN"],
      [a, { ...note, projectId: "prj_missing" }, "PROJECT_UNKNOWN"],
    ] as const)
      expect(refusal(await f.core.send(f.caller(sender), input)).code).toBe(
        code,
      );
    expect(f.rows("inbox_items")).toEqual([]);
    expect(f.rings).toEqual([]);
  },
  timeout,
);

test(
  "X3 explicit send targets must belong to the recipient and match the project",
  async () => {
    const f = await baseFixture({ ring: true });
    const { sessionId } = f.bind();
    const target = f.unbound({}, b);
    const wrongProject = f.bind(b).sessionId;
    f.db
      .prepare("UPDATE sessions SET project_id = ? WHERE session_id = ?")
      .run(p2, wrongProject);
    const { itemId } = value(
      await f.core.send(f.caller(), {
        ...draft(sessionId),
        targetSessionId: target.sessionId,
      }),
    );
    for (const id of [wrongProject, sessionId, "ses_missing"])
      expect(
        refusal(
          await f.core.send(f.caller(), {
            ...draft(sessionId),
            targetSessionId: id,
          }),
        ).code,
      ).toBe("SESSION_UNKNOWN");
    f.expectItems(target.sessionId, [{ itemId }], b);
    expect(f.col("inbox_items", "item_id")).toEqual([itemId]);
    await until(() => f.rings.length > 0, timeout);
    expect(f.rings).toHaveLength(1);
  },
  timeout,
);

test(
  "X3P a stale child cannot redirect a project item to its parent in another project",
  async () => {
    const f = await baseFixture();
    const sender = f.bind(b);
    const parent = f.bind();
    f.bindProject(parent.sessionId, p2);
    const child = f.unbound({
      projectId: p1,
      parentSessionId: parent.sessionId,
    });
    f.advance(LIMITS.liveSessionMs + 1);
    const { itemId } = value(
      await f.core.send(f.caller(b), {
        ...draft(sender.sessionId),
        toPersonId: a.personId,
        targetSessionId: child.sessionId,
      }),
    );
    expect(f.read(parent.sessionId).items).toEqual([]);
    f.expectItems(child.sessionId, [{ itemId, projectId: p1 }]);
  },
  timeout,
);

test(
  "X4 removed project members cannot read or acknowledge outstanding items",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    const beta = f.bind(b);
    const { itemId } = value(
      await f.core.send(f.caller(), draft(alpha.sessionId)),
    );
    f.expectItems(beta.sessionId, [{ itemId }], b);
    const projects = f.config.projects.map((project) => ({
      ...project,
      memberIds: project.memberIds.filter((id) => id !== b.personId),
    }));
    const restarted = createCoreBase(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, projects },
        people: configPeople(f.config.people),
      }),
    );
    expect(
      value(restarted.inbox(f.caller(b), { sessionId: beta.sessionId })).items,
    ).toEqual([]);
    expect(
      refusal(
        restarted.inbox(f.caller(b), {
          sessionId: beta.sessionId,
          ackItemIds: [itemId],
        }),
      ).code,
    ).toBe("ACK_INVALID");
    expect(f.rows("inbox_items", "item_id,acked_at")).toEqual([
      { item_id: itemId, acked_at: null },
    ]);
  },
  timeout,
);

test(
  "SD2 send refuses unknown, foreign and paused conversations",
  async () => {
    const f = await baseFixture({
      ring: true,
      bells: [bellFor(b.personId, "beta")],
    });
    const alpha = f.bind();
    const beta = f.bind(b, "bound-b", "beta");
    await f.emit("root");
    await f.follow("beta-root", { slackUserId: slackB });
    const alphaConversation = f.read(alpha.sessionId).items[0]!.conversationId;
    const betaConversation = f.read(beta.sessionId, b).items[0]!.conversationId;
    expect(typeof alphaConversation).toBe("string");
    expect(typeof betaConversation).toBe("string");
    for (let index = 0; index < LIMITS.agentRunMax; index++)
      seedThread(
        f,
        "agent-" + index,
        "run",
        "agent",
        a.personId,
        alpha.sessionId,
      );
    const before = f.rows("inbox_items");
    const writes = f.chat.writes.length;
    const rings = f.rings.length;
    for (const [conversationId, code] of [
      ["con_missing", "CONVERSATION_UNKNOWN"],
      [betaConversation!, "CONVERSATION_NOT_YOURS"],
      [alphaConversation!, "CONVERSATION_PAUSED"],
    ] as const)
      expect(
        refusal(
          await f.core.send(f.caller(), {
            ...draft(alpha.sessionId),
            conversationId,
          }),
        ),
      ).toMatchObject({ code, retry: "never" });
    expect(f.rows("inbox_items")).toEqual(before);
    expect(f.chat.writes.slice(writes)).toEqual([
      {
        name: "postText",
        args: [
          { kind: "thread", chatThreadId: thread },
          "Paused: the agents need a person to reply.",
          undefined,
        ],
      },
    ]);
    expect(f.rings).toHaveLength(rings);
  },
  timeout,
);

test(
  "SD1 visible send posts only in project channel conversations and never answers owed rows",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const channelConversation = f.read(alpha.sessionId).items[0]!
      .conversationId!;
    const send = (text: string, conversationId?: string) =>
      f.core.send(f.caller(), {
        ...draft(alpha.sessionId),
        text,
        ...(conversationId === undefined ? {} : { conversationId }),
      });
    const postTexts = () =>
      f.chat.calls
        .filter((call) => call.name === "postText")
        .map((call) => call.args[1]);
    const posted = value(await send("Visible question", channelConversation));
    expect(posted.threadPost).toBe("posted");
    expect(f.writes("postText")).toHaveLength(1);
    const visiblePost =
      "Fixture Alpha's agent asked Fixture Beta's agent: Visible question";
    expect(f.writes("postText")[0]!.args).toEqual([
      { kind: "thread", chatThreadId: thread },
      visiblePost,
      { agentLabel: "Forge (Fixture Alpha's agent)" },
    ]);
    expect(postTexts()).toEqual([visiblePost]);
    expect(f.col("reply_owed", "answered")).toEqual([0]);
    await f.dm("alpha-dm", "Alpha note");
    const dm = f.rows(
      "conversations WHERE is_direct = 1",
      "conversation_id",
    )[0];
    expect(dm).toBeDefined();
    const direct = value(
      await send("Direct note", String(dm!.conversation_id)),
    );
    expect(direct.threadPost).toBeUndefined();
    const privateSend = value(await send("Private note"));
    expect(privateSend.threadPost).toBeUndefined();
    expect(postTexts()).toEqual([visiblePost]);
    const longText = "Long summary\n---\n" + "detail ".repeat(400);
    const longPosted = value(await send(longText, channelConversation));
    expect(longPosted.threadPost).toBe("posted");
    expect(f.writes("createLongAnswer")).toHaveLength(1);
    expect(f.writes("createLongAnswer")[0]!.args).toEqual([
      channel,
      "Fixture One: Long summary",
      longText,
    ]);
    const longPost =
      "Fixture Alpha's agent asked Fixture Beta's agent: " +
      "Long summary\nFull answer: https://example.test/canvas/message-2";
    expect(f.writes("postText")[1]!.args[1]).toBe(longPost);
    expect(postTexts()).toEqual([visiblePost, longPost]);
    const itemsBefore = f.rows(
      "inbox_items WHERE kind = 'agent_message'",
      "item_id",
    );
    expect(refusal(await send("token xoxb-0123456789abcdef"))).toEqual({
      code: "SECRET_IN_TEXT",
      message: "The text contains a possible secret.",
      retry: "never",
      pointer: "/text",
    });
    expect(postTexts()).toEqual([visiblePost, longPost]);
    expect(
      f.rows("inbox_items WHERE kind = 'agent_message'", "item_id"),
    ).toEqual(itemsBefore);
    f.chat.nextWrite = { kind: "refused", reason: "not_in_channel" };
    const failed = value(await send("Refused visible", channelConversation));
    expect(failed.threadPost).toBe("failed");
    expect(postTexts()).toEqual([
      visiblePost,
      longPost,
      "Fixture Alpha's agent asked Fixture Beta's agent: Refused visible",
    ]);
    expect(f.writes("postText")).toHaveLength(2);
    expect(
      f.rows("inbox_items WHERE kind = 'agent_message'", "item_id"),
    ).toHaveLength(5);
  },
  timeout,
);

test(
  "SD1 visible send refuses a conversation from another project",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    expect(
      refusal(
        await f.core.send(f.caller(), {
          sessionId: alpha.sessionId,
          projectId: p2,
          toPersonId: c.personId,
          conversationId,
          text: "Cross-project note",
        }),
      ),
    ).toMatchObject({ code: "INPUT_INVALID", pointer: "/conversationId" });
    expect(f.rows("inbox_items WHERE kind = 'agent_message'")).toEqual([]);
    expect(f.writes("postText")).toEqual([]);
    await f.dm("alpha-dm", "Alpha note");
    const dm = f.rows(
      "conversations WHERE is_direct = 1",
      "conversation_id",
    )[0];
    const direct = value(
      await f.core.send(f.caller(), {
        sessionId: alpha.sessionId,
        projectId: p2,
        toPersonId: c.personId,
        conversationId: String(dm!.conversation_id),
        text: "Direct cross-project note",
      }),
    );
    expect(direct.threadPost).toBeUndefined();
    expect(
      f.rows("inbox_items WHERE kind = 'agent_message'", "item_id"),
    ).toHaveLength(1);
  },
  timeout,
);

test(
  "SD1 visible send refuses a conversation in a channel the project left",
  async () => {
    const f = await baseFixture({
      ring: true,
      bells: [bellFor(b.personId, "beta")],
    });
    f.bind();
    const beta = f.bind(b);
    await f.emit("root", { slackUserId: slackB });
    const conversationId = f.read(beta.sessionId, b).items[0]!.conversationId!;
    const send = (core: typeof f.core) =>
      core.send(f.caller(b), {
        sessionId: beta.sessionId,
        projectId: p1,
        toPersonId: a.personId,
        conversationId,
        text: "Stale channel note",
      });
    expect(value(await send(f.core)).threadPost).toBe("posted");
    await until(() => f.rings.length > 0, timeout);
    const projects = f.config.projects.map((project) => {
      if (project.projectId === p1)
        return { ...project, slackChannelId: "C00000009" };
      return { ...project, slackChannelId: "C00000001" };
    });
    const moved = createCoreBase(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, projects },
        people: configPeople(f.config.people),
      }),
    );
    const items = f.rows("inbox_items");
    const writes = f.chat.writes.length;
    const rings = f.rings.length;
    expect(refusal(await send(moved))).toMatchObject({
      code: "INPUT_INVALID",
      pointer: "/conversationId",
      retry: "never",
    });
    expect(f.rows("inbox_items")).toEqual(items);
    expect(f.chat.writes).toHaveLength(writes);
    expect(f.rings).toHaveLength(rings);
  },
  timeout,
);

test(
  "SD1 visible send with chat off stores the item and reports failed",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const off = createCoreBase(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, slack: { ...f.config.slack, mode: "off" } },
        people: configPeople(f.config.people),
      }),
    );
    const sent = value(
      await off.send(f.caller(), {
        ...draft(alpha.sessionId),
        conversationId,
        text: "Offline visible note",
      }),
    );
    expect(sent.threadPost).toBe("failed");
    expect(f.writes("postText")).toEqual([]);
    expect(
      f.rows("inbox_items WHERE kind = 'agent_message'", "item_id"),
    ).toHaveLength(1);
  },
  timeout,
);

test(
  "SD1 visible send refuses when the project channel is rebound during the thread wait",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const beforeInbox = f.rows("inbox_items");
    const beforeThreads = f.rows("thread_messages");
    const beforeConvs = f.rows("conversations");
    const beforeOwed = f.rows("reply_owed");
    const beforeWrites = f.chat.writes.length;
    const releaseGate = await enterThread(f.context, thread);
    const pending = f.core.send(f.caller(), {
      ...draft(alpha.sessionId),
      conversationId,
      text: "Race note",
    });
    await Bun.sleep(10);
    const rebound = f.config.projects.map((project) =>
      project.projectId === p1
        ? { ...project, slackChannelId: "C00000009" }
        : project,
    );
    createCoreBase(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, projects: rebound },
        people: configPeople(f.config.people),
      }),
    );
    releaseGate();
    expect(refusal(await pending)).toEqual({
      code: "INPUT_INVALID",
      message: "The input is invalid.",
      retry: "never",
      pointer: "/conversationId",
    });
    expect(f.rows("inbox_items")).toEqual(beforeInbox);
    expect(f.rows("thread_messages")).toEqual(beforeThreads);
    expect(f.rows("conversations")).toEqual(beforeConvs);
    expect(f.rows("reply_owed")).toEqual(beforeOwed);
    expect(f.chat.writes).toHaveLength(beforeWrites);
    createCoreBase(
      createCoreContext({
        ...f.deps,
        config: f.config,
        people: configPeople(f.config.people),
      }),
    );
    const retry = value(
      await f.core.send(f.caller(), {
        ...draft(alpha.sessionId),
        conversationId,
        text: "After rebind",
      }),
    );
    expect(retry.threadPost).toBe("posted");
  },
  timeout,
);

test(
  "SD1 visible send posts when the channel is unchanged across the thread wait",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    await f.emit("root");
    const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
    const releaseGate = await enterThread(f.context, thread);
    const pending = f.core.send(f.caller(), {
      ...draft(alpha.sessionId),
      conversationId,
      text: "Held note",
    });
    await Bun.sleep(10);
    releaseGate();
    const sent = value(await pending);
    expect(sent.threadPost).toBe("posted");
    expect(f.writes("postText")).toHaveLength(1);
    expect(
      f.rows("inbox_items WHERE kind = 'agent_message'", "item_id"),
    ).toHaveLength(1);
  },
  timeout,
);
