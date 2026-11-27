import { expect, test } from "bun:test";
import {
  baseFixture,
  bellFor,
  channel,
  thread,
  unknownUser,
} from "./base-fixture.ts";
import { a, b } from "./fixture.ts";
import { slackA, slackB } from "./fakes.ts";

const timeout = 30_000;
const gamma = "U00000003";

test(
  "AD1 explicit addressing sends untrusted text only to the named agent",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const alpha = f.bind();
    const beta = f.bind(b, "beta", "beta");
    await f.emit("ask-beta", { mentionedSlackUserIds: [slackB] });
    expect(f.col("conversations", "person_id")).toEqual([b.personId]);
    expect(
      f.rows(
        "inbox_items",
        "owner_person_id,target_session_id,sender_person_id,not_your_owner",
      ),
    ).toEqual([
      {
        owner_person_id: b.personId,
        target_session_id: beta.sessionId,
        sender_person_id: a.personId,
        not_your_owner: 1,
      },
    ]);
    expect(f.read(alpha.sessionId).items).toEqual([]);
    expect(f.read(beta.sessionId, b)).toMatchObject({
      mode: "reply_only",
      items: [
        {
          trust: "not_your_owner",
          from: { kind: "person", personId: a.personId },
        },
      ],
    });
  },
  timeout,
);

test(
  "AD2 three named targets are accepted and four are refused without delivery",
  async () => {
    const people = [4, 5, 6].map((n) => ({
      personId: "per_" + n,
      displayName: "Member " + n,
      slackUserId: "U0000000" + n,
    }));
    const f = await baseFixture({
      extraPeople: people,
      bells: [b, ...people].map((person) => bellFor(person.personId)),
    });
    for (const person of [b, ...people]) f.bind(person);
    const targets = [slackB, ...people.map((person) => person.slackUserId)];
    await f.emit("three", { mentionedSlackUserIds: targets.slice(0, 3) });
    expect(f.rows("conversations", "conversation_id")).toHaveLength(3);
    expect(f.rows("inbox_items", "item_id")).toHaveLength(3);
    const reactions = () => f.writes("react").map((call) => call.args);
    expect(reactions()).toEqual([
      [
        { channelId: channel, chatThreadId: thread, chatMessageId: "three" },
        "eyes",
      ],
    ]);
    await f.emit("four", {
      chatThreadId: thread + "2",
      mentionedSlackUserIds: targets,
    });
    expect(f.posts()).toEqual(["Name at most 3 people."]);
    expect(f.rows("conversations", "conversation_id")).toHaveLength(3);
    expect(f.rows("inbox_items", "item_id")).toHaveLength(3);
    expect(reactions()).toHaveLength(1);
  },
  timeout,
);

test(
  "AD3 refused targets never fall back and self-mentions keep normal routing",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.bind();
    await f.emit("no-bell", { mentionedSlackUserIds: [slackB, unknownUser] });
    await f.emit("nonmember", {
      mentionedSlackUserIds: [gamma],
      chatThreadId: thread + "2",
    });
    await f.emit("unknown-only", {
      mentionedSlackUserIds: [unknownUser],
      chatThreadId: thread + "3",
    });
    await f.emit("direct", {
      channelId: "D00000001",
      chatThreadId: "slack:D00000001:1.000001",
      isDirect: true,
      mentionedSlackUserIds: [slackB],
    });
    expect(f.posts()).toEqual([
      "Fixture Beta has no agent set up for Fixture One.",
      "Fixture Gamma has no agent set up for Fixture One.",
      "None of those people are set up in Forge for this project.",
      "Ask Fixture Beta's agent in a project channel so Fixture Beta can see it.",
    ]);
    expect(f.rows("conversations")).toEqual([]);
    expect(f.rows("inbox_items")).toEqual([]);
    await f.emit("self", { mentionedSlackUserIds: [slackA] });
    f.expectItems(sessionId, [{ text: "self", trust: "owner" }]);
  },
  timeout,
);

test(
  "AD4 accepted mentions react once each and store one queued notice for the recipient",
  async () => {
    const f = await baseFixture({ bells: [bellFor(b.personId, "beta")] });
    const mentionedSlackUserIds = [slackB];
    await f.emit("first-addressed", { mentionedSlackUserIds });
    await f.emit("second-addressed", {
      mentionedSlackUserIds,
      threadRootMessageId: "first-addressed",
    });
    expect(f.writes("react").map((call) => call.args)).toEqual(
      ["first-addressed", "second-addressed"].map((chatMessageId) => [
        { channelId: channel, chatThreadId: thread, chatMessageId },
        "eyes",
      ]),
    );
    const queued = "Queued for Fixture Beta's agent.";
    expect(f.posts()).toEqual([queued]);
    expect(
      f.rows("thread_messages WHERE kind = 'system'", "kind,text"),
    ).toEqual([{ kind: "system", text: queued }]);
  },
  timeout,
);
