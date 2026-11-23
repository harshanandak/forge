import { expect, test } from "bun:test";
import {
  slackPlatformCode,
  toChatWriteFailure,
  validateRetryAfterResponse,
} from "../../src/chat/failure.ts";
import { ChatWriteFailure } from "../../src/contract/chat.ts";

const timeout = 30_000;

const platformError = (error: unknown) => ({
  code: "slack_webapi_platform_error",
  data: { ok: false, error },
});

const rateError = (retryAfter: unknown) => ({
  code: "slack_webapi_rate_limited_error",
  retryAfter,
});

test(
  "X1 the WebClient rate error carries seconds converted without shortening",
  () => {
    const failure = toChatWriteFailure(rateError(30));
    expect(failure).toBeInstanceOf(ChatWriteFailure);
    expect(failure.effect).toBe("refused");
    expect(failure.retryAfterMs).toBe(30_000);
    expect(Object.keys(failure).sort()).toEqual(["effect", "retryAfterMs"]);
  },
  timeout,
);

for (const reason of [
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "restricted_action",
] as const) {
  test(
    `X2 and RS1 a definite Slack refusal preserves the allowed reason ${reason}`,
    () => {
      const error = platformError(reason);
      expect(slackPlatformCode(error)).toBe(reason);
      const failure = toChatWriteFailure(error);
      expect(failure.effect).toBe("refused");
      expect(failure.reason).toBe(reason);
      expect(Object.keys(failure).sort()).toEqual(["effect", "reason"]);
    },
    timeout,
  );
}

for (const [row, error] of [
  ["X3 request timeout", { code: "slack_webapi_request_error" }],
  ["X4 cut-off request or response", new Error("socket closed")],
  ["X5 server failure", { code: "slack_webapi_http_error", statusCode: 500 }],
  ["X5 unexpected success status", { code: "slack_webapi_http_error", statusCode: 201 }],
  ["X5 corrupt platform result", platformError(42)],
  ["X5 payload not an error", null],
  ["X5 platform rate limit without an HTTP delay", platformError("ratelimited")],
  ["X5 partly applied operation", platformError("internal_error")],
  ["X5 fatal error after possible application", platformError("fatal_error")],
] as const) {
  test(
    row,
    () => {
      const failure = toChatWriteFailure(error);
      expect(failure.effect).toBe("unknown");
      expect(Object.keys(failure)).toEqual(["effect"]);
    },
    timeout,
  );
}

test(
  "X5 an HTTP error carrying a definite allowlisted Slack refusal preserves its reason",
  () => {
    const failure = toChatWriteFailure({
      code: "slack_webapi_http_error",
      statusCode: 403,
      body: { ok: false, error: "restricted_action" },
    });
    expect(failure.effect).toBe("refused");
    expect(failure.reason).toBe("restricted_action");
  },
  timeout,
);

test(
  "X6 and RS3 strip the SDK error, cause, request data and arbitrary Slack text",
  () => {
    const synthetic = ["xo", "xb", "-", "sample-fixture"].join("");
    const sdkError = Object.assign(new Error(synthetic), {
      ...platformError("not_in_channel"),
      cause: new Error(synthetic),
      headers: { authorization: synthetic },
      data: {
        ...platformError("not_in_channel").data,
        warning: "private ask text",
        response_metadata: { messages: [synthetic] },
      },
    });
    const failure = toChatWriteFailure(sdkError);
    expect(failure).toBeInstanceOf(ChatWriteFailure);
    expect(failure.message).toBe("CHAT_UNAVAILABLE");
    expect(failure.reason).toBe("not_in_channel");
    expect(Object.keys(failure).sort()).toEqual(["effect", "reason"]);
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(synthetic);
    expect(JSON.stringify(failure)).not.toContain("private ask text");
    expect(String(failure)).not.toContain(synthetic);
  },
  timeout,
);

for (const error of [
  "invalid_auth",
  "msg_too_long",
  "user_not_found",
  "account_inactive",
]) {
  test(
    `RS2 a definite refusal with unlisted code ${error} has no public reason`,
    () => {
      const failure = toChatWriteFailure(platformError(error));
      expect(failure.effect).toBe("refused");
      expect(Object.keys(failure)).toEqual(["effect"]);
    },
    timeout,
  );
}

test(
  "X8 valid raw delays preserve the next transform's input, including zero and long delays",
  () => {
    const data = { ok: false };
    for (const seconds of [0, 99_999, 9_007_199_254_740]) {
      expect(
        validateRetryAfterResponse(data, { "retry-after": String(seconds) }, 429),
      ).toBe(data);
      expect(toChatWriteFailure(rateError(seconds)).retryAfterMs).toBe(
        seconds * 1_000,
      );
    }
    expect(validateRetryAfterResponse(data, undefined, 500)).toBe(data);
  },
  timeout,
);

for (const [label, header] of [
  ["missing", undefined],
  ["junk", "soon"],
  ["fractional", "1.5"],
  ["negative", "-3"],
  ["HTTP date", "Wed, 21 Oct 2015 07:28:00 GMT"],
  ["out of range", "9007199254741"],
  ["leading integer and junk", "1soon"],
  ["duplicate", ["1", "2"]],
] as const) {
  test(
    `X8 rejects a ${label} delay before the WebClient parses it`,
    () => {
      try {
        validateRetryAfterResponse({}, { "retry-after": header }, 429);
      } catch (error) {
        if (!(error instanceof ChatWriteFailure)) throw error;
        expect(error.effect).toBe("unknown");
        expect(Object.keys(error)).toEqual(["effect"]);
        return;
      }
      throw new Error("invalid Retry-After was accepted");
    },
    timeout,
  );
}

test(
  "X8 the classifier treats invalid SDK delays as unknown",
  () => {
    for (const value of [undefined, -1, 1.5, NaN, Infinity, "1", 9_007_199_254_741]) {
      const failure = toChatWriteFailure(rateError(value));
      expect(failure.effect).toBe("unknown");
      expect(Object.keys(failure)).toEqual(["effect"]);
    }
  },
  timeout,
);
