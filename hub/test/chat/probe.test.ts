import { expect, test } from "bun:test";
import { channel, team } from "../fakes/fake-slack-server.ts";
import { slackCases, failure, sampleBotToken } from "./fixtures.ts";

const timeout = 30_000;
const { idle: idleCase } = slackCases(test, timeout);
const second = "C0PROJ2";

for (const invisible of [false, true]) {
  idleCase(
    invisible
      ? "PR2 an invisible channel is reported without failing the probe"
      : "PR1 probes the authenticated team and each channel in order",
    async (h) => {
      h.fake.script(
        "conversations.info",
        { result: { ok: true, channel: { id: channel, is_member: true } } },
        {
          result: invisible
            ? { ok: false, error: "channel_not_found" }
            : { ok: true, channel: { id: second, is_member: false } },
        },
      );
      expect(await h.port().probe([channel, second])).toEqual({
        teamId: team,
        channels: [
          { channelId: channel, botIsMember: true },
          { channelId: second, botIsMember: false },
        ],
      });
      expect(h.fake.calls.map(({ method }) => method)).toEqual([
        "auth.test",
        "conversations.info",
        "conversations.info",
      ]);
      expect(
        h.fake.only("conversations.info").map((body) => body.channel),
      ).toEqual([channel, second]);
    },
  );
}

for (const [label, script, effect, delay] of [
  [
    "authentication",
    { result: { ok: false, error: "invalid_auth" } },
    "refused",
    undefined,
  ],
  ["server", { status: 500 }, "unknown", undefined],
  ["rate limit", { status: 429, retryAfter: "7" }, "refused", 7_000],
] as const) {
  idleCase(
    `PR3 classifies and sanitizes a ${label} probe failure`,
    async (h) => {
      h.fake.script("auth.test", script);
      const rejected = await failure(() => h.port().probe([channel]));
      expect(rejected).toMatchObject({ message: "CHAT_UNAVAILABLE", effect });
      expect(rejected.retryAfterMs).toBe(delay);
      expect(rejected.reason).toBeUndefined();
      for (const value of [sampleBotToken, h.fake.url, "invalid_auth"])
        expect(String(rejected) + JSON.stringify(rejected)).not.toContain(
          value,
        );
      expect(h.fake.only("conversations.info")).toEqual([]);
    },
  );
}

idleCase(
  "PR4 the probe needs neither start nor a database",
  async (h) => {
    const port = h.port();
    expect(await port.probe([])).toEqual({ teamId: team, channels: [] });
    expect(h.fake.calls.map(({ method }) => method)).toEqual(["auth.test"]);
    h.fake.calls.length = 0;
    expect(await port.probe([channel])).toEqual({
      teamId: team,
      channels: [{ channelId: channel, botIsMember: true }],
    });
    expect(h.fake.calls.map(({ method }) => method)).toEqual([
      "auth.test",
      "conversations.info",
    ]);
  },
  { noDatabase: true },
);
