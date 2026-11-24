import { expect, test } from "bun:test";
import type { HookSessionSource } from "../../src/contract/domain.ts";
import { HUB_RULES, HUB_RULES_NO_SLACK } from "../../src/contract/mcp.ts";
import type { SessionStore } from "../../src/core/store.ts";
import { a, caller, sessionFixture, seedHost, value } from "./fixture.ts";

const timeout = 30_000;
const host = "claude";
const bound = { person: a, hostInstanceId: "hst_a" };
const input = { host, hostSessionId: "owner-session" } as const;
const unbound = { mode: "reply_only", modeReason: "unbound_start" };
const restored = { mode: "reply_only", modeReason: "resume_unknown" };
const clean = { mode: "normal", modeReason: "start" };

function register(
  s: SessionStore,
  source: HookSessionSource,
  id: string = input.hostSessionId,
  threadId = "T1",
  identity = bound,
) {
  return value(
    s.hookSession(identity, { host, hostSessionId: id, source, threadId }),
  );
}

test(
  "M3: new sessions start in the required mode",
  async () => {
    const { db, sessions: s } = await sessionFixture();
    seedHost(db);
    const fresh = value(s.hello(caller, { host: "t3" }));
    expect(s.session(fresh.sessionId)).toMatchObject(unbound);
    for (const source of ["startup", "clear"] as const) {
      const { sessionId } = register(s, source, source);
      const before = s.session(sessionId);
      expect(before).toMatchObject({ ...clean, host, hostInstanceId: "hst_a" });
      const hello = value(s.hello(caller, { host: "codex", sessionId }));
      expect(hello).toMatchObject({ bound: true, mode: "normal" });
      expect(s.session(sessionId)).toEqual(before);
    }
  },
  timeout,
);

test(
  "M4: restored modes and thread bindings persist",
  async () => {
    const { db, sessions: s } = await sessionFixture();
    seedHost(db);
    seedHost(db, "hst_b");
    const first = register(s, "resume");
    const compact = register(s, "compact", "compact-session");
    for (const row of [first, compact])
      expect(s.session(row.sessionId)).toMatchObject(restored);
    expect(register(s, "startup", input.hostSessionId, "T2")).toEqual(first);
    expect(s.session(first.sessionId)?.threadId).toBe("T1");
    const other = { ...bound, hostInstanceId: "hst_b" };
    expect(
      register(s, "startup", input.hostSessionId, "T2", other).sessionId,
    ).not.toBe(first.sessionId);
    expect(value(s.hookMode(bound, input))).toMatchObject({
      sessionId: first.sessionId,
      mode: "reply_only",
    });
  },
  timeout,
);

test(
  "M5: each untrusted read increments the ancestor chain only",
  async () => {
    const { db, sessions: s } = await sessionFixture();
    const parent = s.createUnboundSession(a, undefined, host);
    const underParent = { host, parentSessionId: parent.sessionId } as const;
    const child = value(s.hello(caller, underParent));
    const sibling = value(s.hello(caller, underParent));
    for (const seq of [1, 2]) {
      db.transaction(() => s.markUntrustedRead(child.sessionId));
      const expected = {
        mode: "reply_only",
        modeReason: "read_untrusted",
        untrustedReadSeq: seq,
      };
      for (const id of [child.sessionId, parent.sessionId])
        expect(s.session(id)).toMatchObject(expected);
      expect(s.session(sibling.sessionId)?.untrustedReadSeq).toBe(0);
    }
  },
  timeout,
);

test(
  "M6: mode guard checks the named session",
  async () => {
    const { db, sessions: s } = await sessionFixture();
    seedHost(db);
    const normal = value(
      s.requireOwnSession(a, register(s, "startup").sessionId),
    );
    const replyOnly = s.createUnboundSession(a, undefined, host);
    expect(s.requireNormalMode(normal)).toBeUndefined();
    expect(s.requireNormalMode(replyOnly)).toMatchObject({
      code: "REPLY_ONLY",
      retry: "reconcile_first",
    });
  },
  timeout,
);

test(
  "M7: hello returns the configured rules",
  async () => {
    const off = { mode: "off", buttons: false } as const;
    for (const mode of [undefined, off]) {
      const { sessions: s } = await sessionFixture(mode ? { slack: mode } : {});
      const hello = value(s.hello(caller, { host }));
      expect(hello.rules).toEqual(mode ? HUB_RULES_NO_SLACK : HUB_RULES);
      expect(s.session(hello.sessionId)).toMatchObject({
        ...unbound,
        untrustedReadSeq: 0,
      });
    }
  },
  timeout,
);
