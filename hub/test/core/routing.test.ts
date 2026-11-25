import { expect, test } from "bun:test";
import { LIMITS } from "../../src/contract/mcp.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { baseFixture, bellFor, seedThread } from "./base-fixture.ts";
import { a, b, p1, p2 } from "./fixture.ts";
import { slackB } from "./fakes.ts";

const timeout = 30_000;
const gamma = "U00000003";
const fallbackNotice =
  "Fixture Beta has no agent set up for Fixture One. Fixture Alpha's agent will see this.";
const secondThread = "slack:C00000001:11.000001";
const pending =
  "SELECT owner_person_id,target_session_id,project_id,held FROM inbox_items ORDER BY rowid";
const conversations =
  "SELECT person_id,session_id,project_id FROM conversations ORDER BY rowid";

test(
  "R1 a multi-project DM stays held until the sender picks a project",
  async () => {
    const f = await baseFixture();
    const alpha = f.bind();
    f.bindProject(alpha.sessionId);
    const other = f.bind(a, "other");
    f.bindProject(other.sessionId, p2);
    await f.dm("first", "Help");
    expect(f.sql(pending)).toMatchObject([
      { owner_person_id: a.personId, project_id: null, held: 1 },
    ]);
    expect(f.sql(conversations)).toMatchObject([{ project_id: null }]);
    expect(f.read(alpha.sessionId).items).toEqual([]);
    expect(f.read(other.sessionId).items).toEqual([]);
    await f.dm("pick", "fixture two", undefined, "first");
    expect(f.sql(pending)).toMatchObject([{ project_id: p2, held: 0 }]);
    expect(f.sql(conversations)).toMatchObject([{ project_id: p2 }]);
    expect(f.read(alpha.sessionId).items).toEqual([]);
    f.expectItems(other.sessionId, [{ text: "Help", projectId: p2 }]);
  },
  timeout,
);

test(
  "R1R retrying a DM project choice does not release or insert another item",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    f.bindProject(sessionId, p2);
    await f.dm("first", "Help");
    await f.dm("picker", p2, undefined, "first");
    const released = f.rows("inbox_items");
    expect(released).toMatchObject([{ text: "Help", project_id: p2, held: 0 }]);
    await f.dm("picker", p2, undefined, "first");
    expect(f.rows("inbox_items")).toEqual(released);
    f.advance(1);
    await f.dm("later", p2, undefined, "first");
    f.expectItems(sessionId, [{ text: "Help" }, { text: p2 }]);
  },
  timeout,
);

test(
  "R2 nonmembers and non-project channels are refused before storage",
  async () => {
    const f = await baseFixture();
    await f.emit("wrong-person", { slackUserId: gamma });
    await f.emit("wrong-channel", {
      channelId: "C00009999",
      chatThreadId: "slack:C00009999:10.000001",
    });
    expect(f.writes("postEphemeral").map((call) => call.args[2])).toEqual([
      "You are not a member of this Forge project.",
      "This channel is not a Forge project.",
    ]);
    for (const table of ["conversations", "inbox_items", "thread_messages"])
      expect(f.sql("SELECT * FROM " + table)).toEqual([]);
  },
  timeout,
);

test(
  "R3 route to the newest front-thread session, otherwise the same person untargeted",
  async () => {
    const f = await baseFixture();
    await f.emit("no-front-yet", { slackUserId: slackB });
    f.bind();
    f.advance(1);
    const newer = f.bind(a, "newer");
    await f.emit("with-front", {
      chatThreadId: secondThread,
      slackUserId: slackB,
    });
    expect(f.sql(pending)).toMatchObject([
      { owner_person_id: a.personId, target_session_id: null },
      { owner_person_id: a.personId, target_session_id: newer.sessionId },
    ]);
    expect(
      f
        .posts()
        .filter(
          (text) => typeof text === "string" && text.includes("has no agent"),
        ),
    ).toEqual([fallbackNotice, fallbackNotice]);
  },
  timeout,
);

test(
  "R4 an unbound session can claim an untargeted item but is never the front target",
  async () => {
    const f = await baseFixture();
    const session = f.unbound({ projectId: p1 });
    await f.emit("unbound", { slackUserId: slackB });
    expect(f.sql(pending)).toMatchObject([
      { owner_person_id: a.personId, target_session_id: null },
    ]);
    f.expectItems(session.sessionId, [{ text: "unbound" }]);
  },
  timeout,
);

test(
  "R5 a stale child's item goes to its parent",
  async () => {
    const f = await baseFixture();
    const parent = f.bind();
    const child = f.unbound({ parentSessionId: parent.sessionId });
    await f.emit("root");
    const initial = f.read(parent.sessionId).items[0]!;
    f.ack(parent.sessionId, [initial.itemId]);
    f.db
      .prepare("UPDATE conversations SET session_id = ?")
      .run(child.sessionId);
    const childRows = () =>
      f.sql("SELECT * FROM sessions WHERE session_id = ?", child.sessionId);
    const before = childRows();
    f.advance(LIMITS.liveSessionMs + 1);
    f.bindProject(parent.sessionId);
    await f.follow("for-child");
    f.expectItems(parent.sessionId, [
      { text: "for-child", forSubagentSessionId: child.sessionId },
    ]);
    expect(childRows()).toEqual(before);
  },
  timeout,
);

test(
  "R6 bind at first delivery and only move a stale binding to a newer same-thread session",
  async () => {
    const f = await baseFixture();
    const first = f.bind(a, "first", "unconfigured-thread");
    await f.emit("root");
    expect(f.sql(conversations)).toMatchObject([
      { person_id: a.personId, project_id: p1, session_id: null },
    ]);
    const firstItem = f.read(first.sessionId).items[0]!;
    expect(f.sql(conversations)).toMatchObject([
      { session_id: first.sessionId },
    ]);
    f.ack(first.sessionId, [firstItem.itemId]);
    f.advance(1);
    const newer = f.bind(a, "newer", "unconfigured-thread");
    await f.follow("while-live");
    expect(f.sql(pending)[1]).toMatchObject({
      target_session_id: first.sessionId,
    });
    const secondItem = f.read(first.sessionId).items[0]!;
    f.ack(first.sessionId, [secondItem.itemId]);
    f.advance(LIMITS.liveSessionMs + 1);
    f.bindProject(newer.sessionId);
    f.advance(1);
    f.bind(a, "wrong-thread");
    f.bind(b, "wrong-person", "unconfigured-thread");
    await f.follow("after-stale");
    f.expectItems(newer.sessionId, [{ text: "after-stale" }]);
    expect(f.sql(conversations)).toEqual([
      { person_id: a.personId, project_id: p1, session_id: newer.sessionId },
    ]);
  },
  timeout,
);

test(
  "R6P a conversation skips its bound session after it joins another project",
  async () => {
    const f = await baseFixture();
    const claimant = f.bind(a, "claimant", "unconfigured-thread");
    await f.emit("root");
    const [first] = f.read(claimant.sessionId).items;
    f.ack(claimant.sessionId, [first!.itemId]);
    f.bindProject(claimant.sessionId, p2);
    const compatible = f.bind();
    f.bindProject(compatible.sessionId);
    await f.follow("after-project-binding");
    expect(f.sql(pending)[1]).toMatchObject({ target_session_id: null });
    expect(f.read(claimant.sessionId).items).toEqual([]);
    f.expectItems(compatible.sessionId, [
      { text: "after-project-binding", projectId: p1 },
    ]);
    expect(f.sql(conversations)).toEqual([
      { person_id: a.personId, project_id: p1, session_id: claimant.sessionId },
    ]);
  },
  timeout,
);

test(
  "R7 one conversation per person in a shared thread with event dedupe",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const alpha = f.bind();
    const beta = f.bind(b, "beta", "beta");
    await f.emit("root");
    const followup = { slackUserId: slackB, threadRootMessageId: "root" };
    await f.emit("beta-mention", followup);
    await f.emit("beta-mention", followup);
    await f.emit("beta-mention", followup);
    expect(f.rows("conversations ORDER BY rowid", "person_id")).toEqual([
      { person_id: a.personId },
      { person_id: b.personId },
    ]);
    f.expectItems(alpha.sessionId, [{ text: "root", trust: "owner" }]);
    f.expectItems(
      beta.sessionId,
      [{ text: "beta-mention", trust: "owner" }],
      b,
    );
    expect(f.col("inbox_items", "not_your_owner")).toEqual([0, 0]);
  },
  timeout,
);

test(
  "R7C a returning asker keeps their conversation after their doorbell is removed",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const beta = f.bind(b, "beta", "beta");
    await f.emit("root", { slackUserId: slackB });
    const [first] = f.read(beta.sessionId, b).items;
    f.ack(beta.sessionId, [first!.itemId], b);
    const config = {
      ...f.config,
      doorbells: f.config.doorbells.filter(
        (bell) => bell.personId !== b.personId,
      ),
    };
    const restarted = createCoreBase(createCoreContext({ ...f.deps, config }));
    await f.chat.start(restarted.chatHandlers);
    await f.follow("returning-asker", { slackUserId: slackB });
    f.expectItems(
      beta.sessionId,
      [{ text: "returning-asker", trust: "owner" }],
      b,
    );
    expect(f.sql(conversations)).toEqual([
      { person_id: b.personId, project_id: p1, session_id: beta.sessionId },
    ]);
    expect(f.posts()).toEqual([]);
  },
  timeout,
);

test(
  "R8 an unmentioned reply routes to the last speaking agent, or the root",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const alpha = f.bind();
    const beta = f.bind(b, "beta", "beta");
    await f.emit("root");
    await f.follow("beta-root", { slackUserId: slackB });
    const follow = { mentionsBot: false, threadRootMessageId: "root" };
    await f.emit("root-fallback", { ...follow, slackUserId: slackB });
    const agentPost = (id: string, personId: string, sessionId: string) =>
      seedThread(f, id, "Question", "agent", personId, sessionId);
    agentPost("alpha-agent", a.personId, alpha.sessionId);
    await f.emit("for-alpha", { ...follow, slackUserId: slackB });
    agentPost("beta-agent", b.personId, beta.sessionId);
    await f.emit("for-beta", follow);
    await f.emit("not-subscribed", {
      chatThreadId: secondThread,
      mentionsBot: false,
    });
    expect(
      f.rows(
        "inbox_items WHERE text IN ('root-fallback','for-alpha','for-beta') ORDER BY rowid",
        "text,owner_person_id,not_your_owner",
      ),
    ).toEqual([
      { text: "root-fallback", owner_person_id: a.personId, not_your_owner: 1 },
      { text: "for-alpha", owner_person_id: a.personId, not_your_owner: 1 },
      { text: "for-beta", owner_person_id: b.personId, not_your_owner: 1 },
    ]);
    expect(
      f.rows("thread_messages WHERE chat_message_id = 'not-subscribed'"),
    ).toEqual([]);
  },
  timeout,
);

test(
  "R9 front-person fallback posts one setup notice per thread",
  async () => {
    const f = await baseFixture();
    f.bind();
    await f.emit("root", { slackUserId: slackB });
    await f.follow("same-thread", { slackUserId: slackB });
    await f.emit("other-thread", {
      slackUserId: slackB,
      chatThreadId: secondThread,
    });
    expect(f.posts()).toEqual([fallbackNotice, fallbackNotice]);
    const item = { owner_person_id: a.personId, not_your_owner: 1 };
    expect(f.rows("inbox_items", "owner_person_id,not_your_owner")).toEqual([
      item,
      item,
      item,
    ]);
  },
  timeout,
);

test(
  "R10 the DM picker displays purpose but matches only project name or id",
  async () => {
    const f = await baseFixture();
    await f.dm("pick-root");
    expect(f.posts()[0]).toBe(
      "Which project? Reply with one of:\nFixture One: Shared project context\nFixture Two",
    );
    await f.dm("purpose", "Shared project context", undefined, "pick-root");
    expect(f.sql(conversations)).toMatchObject([{ project_id: null }]);
    await f.dm("case-insensitive", p2.toUpperCase(), undefined, "pick-root");
    expect(f.sql(conversations)).toMatchObject([{ project_id: p2 }]);
    expect(f.sql(pending)[0]).toMatchObject({ project_id: p2, held: 0 });
  },
  timeout,
);
