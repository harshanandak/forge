import { expect, test } from "bun:test";
import { a, p1, value } from "./fixture.ts";
import { askFixture, button, refA, rows, slackA } from "./fakes.ts";

const timeout = 30_000;

test(
  "M1: approval clears only the requesting session",
  async () => {
    const f = await askFixture();
    const { sessions } = f.store;
    const untouched = sessions.createUnboundSession(a, p1, "t3");
    for (const choice of ["approve", "decline", "clarify"]) {
      const { sessionId } = sessions.createUnboundSession(a, p1, "t3");
      const { askId } = value(await f.request({ sessionId }));
      expect(
        f.asks.answerAction(button(askId, choice, slackA, choice)).after?.askId,
      ).toBe(askId);
      expect(sessions.session(sessionId)).toMatchObject(
        choice === "approve"
          ? { mode: "normal", modeReason: "request_approved" }
          : { mode: "reply_only", modeReason: "unbound_start" },
      );
      expect(sessions.session(untouched.sessionId)).toEqual(untouched);
    }
  },
  timeout,
);

test(
  "M2: an untrusted read in the same millisecond blocks the clear",
  async () => {
    const f = await askFixture();
    const { sessionId } = f.store.sessions.createUnboundSession(a, p1, "t3");
    const { askId } = value(await f.request({ sessionId }));
    f.store.tx(() => f.store.sessions.markUntrustedRead(sessionId));
    expect(
      f.asks.answerAction(button(askId, "M2", slackA, "approve")).after?.askId,
    ).toBe(askId);
    expect(f.store.sessions.session(sessionId)).toMatchObject({
      mode: "reply_only",
      modeReason: "read_untrusted",
      untrustedReadSeq: 1,
      modeChangedAt: f.deps.now(),
    });
    expect(f.asks.findApprovedPermit(a.personId, p1, askId)?.evidence).toBe(
      "owner_approval",
    );
  },
  timeout,
);

test(
  "M6: reply-only refuses a choice but allows a work request",
  async () => {
    const f = await askFixture();
    const { sessionId } = f.store.sessions.createUnboundSession(a, p1, "t3");
    expect(await f.choice({ sessionId })).toMatchObject({
      ok: false,
      error: { code: "REPLY_ONLY" },
    });
    expect(rows(f.db, "asks")).toEqual([]);
    expect(f.chat.calls).toEqual([]);
    expect(value(await f.request({ sessionId })).deliveredTo).toEqual([refA]);
  },
  timeout,
);
