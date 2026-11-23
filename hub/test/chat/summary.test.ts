import { expect, test } from "bun:test";
import {
  SUMMARY_KEY_MARKER,
  SUMMARY_LOOKUP_LIMIT,
  SUMMARY_LOOKUP_MAX_PAGES,
} from "../../src/contract/chat.ts";
import { asha, botId, botUser, channel } from "../fakes/fake-slack-server.ts";
import {
  failure,
  ref,
  rootTs,
  slackCases,
  type SlackFixture,
  summary,
} from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase, idle: idleCase } = slackCases(test, timeout);
const publicationKey = "sum_a1";
const history = "conversations.history";
const earlierTs = (i: number) =>
  `1800000001.${String(99 - i).padStart(6, "0")}`;
const ordinary = (ts = rootTs) => ({ ts, text: "Ordinary text", user: asha });
const find = (h: SlackFixture) => h.port().findSummary(channel, publicationKey);
const marker = SUMMARY_KEY_MARKER + publicationKey;
const markerBlock = (text = marker) => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});
const candidate = {
  ts: rootTs,
  user: botUser,
  bot_id: botId,
  text: "Atlas",
  blocks: [markerBlock()],
};
const page = (messages: readonly unknown[], nextCursor = "") => ({
  result: {
    ok: true,
    messages,
    has_more: nextCursor !== "",
    response_metadata: { next_cursor: nextCursor },
  },
});

startedCase(
  "O11 posts the exact summary marker as the last context block and edits the same message",
  async (h) => {
    const posted = await h.chat.postSummary(channel, summary, publicationKey);
    const blocks = h.fake.only("chat.postMessage")[0]?.blocks;
    if (!Array.isArray(blocks)) throw new Error("expected Slack blocks");
    expect(blocks.at(-1)).toEqual(markerBlock());
    expect(await h.chat.editSummary(posted, { ...summary, revision: 1 })).toBe(
      "edited",
    );
    const edits = h.fake.only("chat.update");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ channel, ts: posted.chatMessageId });
  },
);

idleCase(
  "O12 a summary can be posted before start with an inaccessible database",
  async (h) => {
    const posted = await h.port().postSummary(channel, summary, publicationKey);
    expect(posted.channelId).toBe(channel);
    expect(h.fake.calls.map(({ method }) => method)).toEqual([
      "chat.postMessage",
    ]);
  },
  { noDatabase: true },
);

startedCase(
  "O13 a missing summary returns missing and a rate limit preserves its delay",
  async (h) => {
    h.fake.script(
      "chat.update",
      { result: { ok: false, error: "message_not_found" } },
      { status: 429, retryAfter: "5" },
    );
    expect(await h.chat.editSummary(ref, summary)).toBe("missing");
    expect(await failure(() => h.chat.editSummary(ref, summary))).toMatchObject(
      {
        effect: "refused",
        retryAfterMs: 5_000,
      },
    );
    expect(h.fake.only("chat.update")).toHaveLength(2);
  },
);

idleCase(
  "F1 finds the canonical summary on a later complete page without starting the port",
  async (h) => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      ordinary(earlierTs(i)),
    );
    h.fake.script(history, page(messages, "cursor-next"), page([candidate]));
    expect(await find(h)).toEqual({ kind: "found", ref });
    const reads = h.fake.only(history);
    expect(reads).toHaveLength(2);
    expect(reads.map(({ limit }) => limit)).toEqual([
      SUMMARY_LOOKUP_LIMIT,
      SUMMARY_LOOKUP_LIMIT,
    ]);
    expect(reads[1]?.cursor).toBe("cursor-next");
  },
  { noDatabase: true },
);

for (const [label, scripts] of [
  [
    "F2 missing channel",
    [{ result: { ok: false, error: "channel_not_found" } }],
  ],
  ["F2 server fault", [{ status: 500 }]],
  [
    "F3 later page timed out",
    [page([ordinary()], "cursor-next"), { delayMs: 12_000 }],
  ],
] as const) {
  idleCase(`${label} cannot prove the summary is absent`, async (h) => {
    h.fake.script(history, ...scripts);
    expect(await find(h)).toEqual({ kind: "unknown" });
    expect(h.fake.only(history)).toHaveLength(scripts.length);
  });
}

for (const [complete, expected] of [
  [true, "found"],
  [false, "unknown"],
] as const) {
  idleCase(
    `F4 a candidate on the twentieth page is ${expected} when history is ${complete ? "complete" : "incomplete"}`,
    async (h) => {
      const pages = Array.from({ length: SUMMARY_LOOKUP_MAX_PAGES }, (_, i) => {
        const last = i === SUMMARY_LOOKUP_MAX_PAGES - 1;
        return page(
          last ? [candidate] : [ordinary(earlierTs(i))],
          last && complete ? "" : `cursor-${i}`,
        );
      });
      h.fake.script(history, ...pages);
      expect(await find(h)).toEqual(
        expected === "found" ? { kind: expected, ref } : { kind: expected },
      );
      expect(h.fake.only(history)).toHaveLength(SUMMARY_LOOKUP_MAX_PAGES);
    },
  );
}

for (const [label, messages] of [
  ["foreign author", [{ ...candidate, bot_id: "B0OTHER", user: asha }]],
  ["fallback text only", [{ ...candidate, text: marker, blocks: [] }]],
  ["prefix collision", [{ ...candidate, blocks: [markerBlock(marker + "x")] }]],
  ["duplicate cards", [candidate, { ...candidate, ts: "1800000000.000001" }]],
] as const) {
  idleCase(`F5 a ${label} marker is inconclusive`, async (h) => {
    h.fake.script(history, page(messages));
    expect(await find(h)).toEqual({ kind: "unknown" });
  });
}

idleCase(
  "F6 only a complete history with no matching marker returns absent",
  async (h) => {
    h.fake.script(
      history,
      page([ordinary("1800000001.000001")], "cursor-next"),
      page([ordinary()]),
    );
    expect(await find(h)).toEqual({ kind: "absent" });
    expect(h.fake.only(history)).toHaveLength(2);
    h.fake.script(history, {
      result: { ok: true, messages: [], has_more: true },
    });
    expect(await find(h)).toEqual({ kind: "unknown" });
  },
);
