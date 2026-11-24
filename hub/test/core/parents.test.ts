import { expect, test } from "bun:test";
import { a, b, caller, sessionFixture, value } from "./fixture.ts";

const timeout = 30_000;

test(
  "B1: hello accepts only a same-person parent on a new unbound session",
  async () => {
    const { db, sessions } = await sessionFixture();
    const x = sessions.createUnboundSession(a, undefined, "t3");
    const other = sessions.createUnboundSession(b, undefined, "t3");
    const y = value(
      sessions.hello(caller, { host: "t3", parentSessionId: x.sessionId }),
    );
    const snapshot = () =>
      db.prepare("SELECT * FROM sessions ORDER BY session_id").all();
    const before = snapshot();
    for (const input of [
      { parentSessionId: other.sessionId },
      { parentSessionId: "ses_missing" },
      { sessionId: x.sessionId, parentSessionId: x.sessionId },
      { sessionId: y.sessionId, parentSessionId: x.sessionId },
      { sessionId: x.sessionId, parentSessionId: y.sessionId },
    ]) {
      expect(sessions.hello(caller, { host: "t3", ...input })).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID", pointer: "/parentSessionId" },
      });
      expect(snapshot()).toEqual(before);
    }
  },
  timeout,
);
