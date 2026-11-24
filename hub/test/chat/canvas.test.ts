import { expect, test } from "bun:test";
import { channel } from "../fakes/fake-slack-server.ts";
import { slackCases, failure } from "./fixtures.ts";

const timeout = 30_000;
const { idle: idleCase } = slackCases(test, timeout);

idleCase(
  "LA0 canvas is unavailable and rejects the write without contacting Slack",
  async (h) => {
    const port = h.port();
    expect(port.capabilities.longAnswers).toBe(false);
    const rejected = await failure(() =>
      port.createLongAnswer(channel, "Title", "Long answer"),
    );
    expect(rejected).toMatchObject({
      effect: "refused",
      reason: "canvas_unavailable",
    });
    expect(h.fake.calls).toEqual([]);
  },
  { noDatabase: true },
);
