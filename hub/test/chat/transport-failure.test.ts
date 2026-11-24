import { expect, test } from "bun:test";
import type { ChatPort, ChatWriteFailure } from "../../src/contract/chat.ts";
import {
  asha,
  channel,
  fakeSlackServer,
  type Script,
} from "../fakes/fake-slack-server.ts";
import {
  slackCases,
  ask,
  failure,
  ref,
  sampleBotToken,
  summary,
  threadTarget,
} from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase } = slackCases(test, timeout);
const publicationKey = "sum_failure";
type Operation = readonly [
  method: string,
  write: (port: ChatPort) => Promise<unknown>,
];
const post = "chat.postMessage";
const methods = {
  postAskDm: [post, (port) => port.postAskDm(asha, ask)],
  editAskDm: ["chat.update", (port) => port.editAskDm(ref, ask)],
  postText: [post, (port) => port.postText(threadTarget, "Agent text")],
  postEphemeral: [
    "chat.postEphemeral",
    (port) => port.postEphemeral(ref, asha, "Private text"),
  ],
  postSummary: [
    post,
    (port) => port.postSummary(channel, summary, publicationKey),
  ],
  editSummary: ["chat.update", (port) => port.editSummary(ref, summary)],
  react: ["reactions.add", (port) => port.react(ref, "eyes")],
} satisfies Record<string, Operation>;

function assertSanitized(rejected: ChatWriteFailure, url: string) {
  const keys = Object.keys(rejected).toSorted();
  expect(keys).toEqual([
    "effect",
    ...(rejected.reason === undefined ? [] : ["reason"]),
    ...(rejected.retryAfterMs === undefined ? [] : ["retryAfterMs"]),
  ]);
  expect(rejected.message).toBe("CHAT_UNAVAILABLE");
  expect(rejected.cause).toBeUndefined();
  const snapshot = JSON.stringify(rejected) + String(rejected);
  for (const text of [
    url,
    sampleBotToken,
    "Retry-After",
    ask.question,
    "Agent text",
    "Private text",
    "hidden platform warning",
  ]) {
    expect(snapshot).not.toContain(text);
  }
}

type ExpectedFailure = {
  effect: ChatWriteFailure["effect"];
  retryAfterMs?: number;
  reason?: string;
  beforeMs?: number;
  afterMs?: number;
};

function failedWrite(
  name: string,
  [method, write]: Operation,
  script: Script,
  want: ExpectedFailure,
) {
  startedCase(name, async (h) => {
    h.fake.script(method, script);
    const start = performance.now();
    const rejected = await failure(() => write(h.chat));
    const elapsed = performance.now() - start;
    if (want.beforeMs !== undefined)
      expect(elapsed).toBeLessThan(want.beforeMs);
    if (want.afterMs !== undefined)
      expect(elapsed).toBeGreaterThanOrEqual(want.afterMs);
    expect(rejected.effect).toBe(want.effect);
    expect(rejected.retryAfterMs).toBe(want.retryAfterMs);
    expect<unknown>(rejected.reason).toBe(want.reason);
    assertSanitized(rejected, h.fake.url);
    expect(h.fake.only(method)).toHaveLength(1);
  });
}

for (const [name, operation] of Object.entries(methods)) {
  failedWrite(
    `X1 X6 ${name} sends one request and immediately preserves a 30-second delay`,
    operation,
    { status: 429, retryAfter: "30" },
    { effect: "refused", retryAfterMs: 30_000, beforeMs: 2_000 },
  );
}

for (const [row, operation, script] of [
  ["X3 delayed ask", methods.postAskDm, { delayMs: 12_000 }],
  ["X3 delayed text", methods.postText, { delayMs: 12_000 }],
  ["X3 delayed summary", methods.postSummary, { delayMs: 12_000 }],
  ["X4 cut-off ask response", methods.postAskDm, { cutOff: true }],
  ["X4 cut-off summary response", methods.postSummary, { cutOff: true }],
  ["X5 unclassified server fault", methods.postText, { status: 500 }],
  ["X5 unexpected success status", methods.postText, { status: 201 }],
] as const) {
  failedWrite(
    `${row} leaves the write uncertain without retrying`,
    operation,
    script,
    { effect: "unknown", ...("delayMs" in script ? { afterMs: 9_000 } : {}) },
  );
}

test(
  "X7 N1 the loopback fixture refuses an unrecognized API method",
  async () => {
    await using fake = await fakeSlackServer();
    expect(new URL(fake.url).hostname).toBe("127.0.0.1");
    const result = await fetch(new URL("chat.delete", fake.url), {
      method: "POST",
      headers: { Authorization: "Bearer " + sampleBotToken },
    });
    expect(result.status).toBe(500);
    expect(fake.unexpected).toEqual(["chat.delete"]);
  },
  timeout,
);

for (const [label, retryAfter, delay] of [
  ["long", "99999", 99_999_000],
  ["zero", "0", 0],
  ["missing", undefined, undefined],
  ["text", "soon", undefined],
  ["fractional", "1.5", undefined],
  ["negative", "-3", undefined],
  ["HTTP date", "Wed, 21 Oct 2015 07:28:00 GMT", undefined],
  ["unrepresentable", "9007199254741", undefined],
] as const) {
  const expected: ExpectedFailure =
    delay === undefined
      ? { effect: "unknown" }
      : { effect: "refused", retryAfterMs: delay };
  const headers = retryAfter === undefined ? {} : { retryAfter };
  failedWrite(
    `X8 the real WebClient preserves valid ${label} delay handling through the port`,
    methods.postText,
    { status: 429, ...headers },
    expected,
  );
}

for (const [row, operation, error] of [
  ["X2 RS1 ask", methods.postAskDm, "channel_not_found"],
  ["X2 RS1 edit", methods.editAskDm, "channel_not_found"],
  ["RS1 text", methods.postText, "not_in_channel"],
  ["RS1 private notice", methods.postEphemeral, "restricted_action"],
  ["RS1 summary", methods.postSummary, "is_archived"],
  ["RS2 auth", methods.postText, "invalid_auth"],
  ["RS2 too long", methods.postText, "msg_too_long"],
  ["RS2 unknown user", methods.postText, "user_not_found"],
  ["RS2 disabled account", methods.postText, "account_inactive"],
] as const) {
  const result = {
    ok: false,
    error,
    warning: "hidden platform warning",
    response_metadata: { messages: [sampleBotToken] },
  };
  const reason = row.startsWith("RS2") ? {} : { reason: error };
  failedWrite(
    `${row} keeps only a defined reason and discards SDK metadata`,
    operation,
    { result },
    { effect: "refused", ...reason },
  );
}
