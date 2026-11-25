import { expect, test } from "bun:test";
import { a, b, seedHost, sessionFixture, value } from "./fixture.ts";

const timeout = 30_000;

test(
  "O1: a different person or host identity gets no session and changes nothing",
  async () => {
    const { db, sessions } = await sessionFixture();
    const foreign = sessions.createUnboundSession(b, undefined, "claude");
    db.exec("UPDATE sessions SET last_seen_at = 1");
    seedHost(db);
    seedHost(db, "hst_b");
    const input = { host: "claude", hostSessionId: "session" } as const;
    value(
      sessions.hookSession(
        { person: a, hostInstanceId: "hst_a" },
        { ...input, source: "startup" },
      ),
    );
    const rows = () =>
      db.prepare("SELECT * FROM sessions ORDER BY session_id").all();
    const before = rows();
    expect(sessions.requireOwnSession(a, foreign.sessionId)).toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_YOURS" },
    });
    expect(sessions.requireOwnSession(a, "ses_unknown")).toMatchObject({
      ok: false,
      error: { code: "SESSION_UNKNOWN" },
    });
    expect(
      value(sessions.hookMode({ person: a, hostInstanceId: "hst_b" }, input)),
    ).toEqual({ mode: "unregistered" });
    expect(rows()).toEqual(before);
  },
  timeout,
);
