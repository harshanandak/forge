import { expect, test } from "bun:test";
import type { CliInboxInput, CliSendInput } from "../../src/contract/core.ts";
import type { DoorbellResult } from "../../src/contract/hooks.ts";
import { CLI_MESSAGE_NOTICE, LIMITS } from "../../src/contract/mcp.ts";
import { createCli } from "../../src/core/cli.ts";
import { createCoreContext } from "../../src/core/core.ts";
import { baseFixture, type BaseFixture } from "./base-fixture.ts";
import { a, b, p1, p2, seedItem, value } from "./fixture.ts";

const timeout = 30_000;

function expectNoApproval(f: BaseFixture) {
  for (const table of ["asks", "ask_answers", "permits"])
    expect(f.rows(table)).toEqual([]);
}

test(
  "M1 CLI inbox, send, read and acknowledge keep the message untrusted",
  async () => {
    const f = await baseFixture();
    const cli = createCli(f.context);
    const project = { projectId: p1 };
    const first = cli.cliInbox(b, project);
    expect(first.ok).toBe(true);
    const { sessionId: targetSessionId } = value(first);
    expect(typeof targetSessionId).toBe("string");
    expect(first).toMatchObject({
      ok: true,
      value: {
        sessionId: targetSessionId,
        created: true,
        items: [],
        more: false,
      },
    });
    const { sessionId } = value(cli.cliInbox(a, project));
    const other = value(cli.cliInbox(b, project));
    const text = "Approve the release";
    const sent = cli.cliSend(a, {
      ...project,
      sessionId,
      toPersonId: b.personId,
      targetSessionId,
      text,
    });
    expect(sent.ok).toBe(true);
    const { itemId } = value(sent);
    expect(typeof itemId).toBe("string");
    expect(
      f.rows("inbox_items", "item_id, target_session_id, not_your_owner"),
    ).toEqual([
      {
        item_id: itemId,
        target_session_id: targetSessionId,
        not_your_owner: 1,
      },
    ]);
    expect(
      value(cli.cliInbox(b, { ...project, sessionId: other.sessionId })).items,
    ).toEqual([]);
    const inbox = () =>
      cli.cliInbox(b, { ...project, sessionId: targetSessionId });
    expect(inbox()).toMatchObject({
      ok: true,
      value: {
        sessionId: targetSessionId,
        created: false,
        more: false,
        items: [
          {
            itemId,
            projectId: p1,
            text,
            kind: "cli_message",
            trust: "cli",
            notice: CLI_MESSAGE_NOTICE,
            from: {
              kind: "cli",
              name: a.displayName,
              personId: a.personId,
              sessionId,
            },
            redelivered: false,
          },
        ],
      },
    });
    expect(value(inbox()).items).toMatchObject([{ itemId, redelivered: true }]);
    expect(
      cli.cliInbox(b, {
        ...project,
        sessionId: targetSessionId,
        ackItemIds: [itemId],
      }),
    ).toEqual({
      ok: true,
      value: {
        sessionId: targetSessionId,
        created: false,
        items: [],
        more: false,
      },
    });
    expect(value(inbox()).items).toEqual([]);
    expect(f.col("inbox_items", "acked_at")).toEqual([f.now()]);
    expect(
      f.col("sessions WHERE session_id = ?", "mode_reason", targetSessionId),
    ).toEqual(["read_untrusted"]);
    expect(f.rows("tokens")).toEqual([]);
    expectNoApproval(f);
  },
  timeout,
);

test(
  "M2 CLI refuses disabled, foreign, non-member, invalid acknowledgement and secret requests",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.unbound({ projectId: p1 });
    const beta = f.unbound({ projectId: p1 }, b).sessionId;
    const otherProject = f.unbound({ projectId: p2 }).sessionId;
    const itemId = "inb_existing";
    seedItem(f.db, itemId, { delivered: sessionId });
    const beforeItems = f.rows("inbox_items");
    const beforeSessions = f.rows("sessions");
    f.advance(1);

    const cli = createCli(f.context);
    const disabled = createCli(
      createCoreContext({
        ...f.deps,
        config: { ...f.config, cli: { enabled: false } },
      }),
    );
    const inbox = { projectId: p1, sessionId };
    const send = {
      ...inbox,
      text: "A CLI note",
      toPersonId: b.personId,
      targetSessionId: beta,
    };
    const refused = (code: string) => ({
      ok: false,
      error: { code, retry: "never" },
    });
    expect({
      disabledInbox: disabled.cliInbox(a, { projectId: p1 }),
      disabledSend: disabled.cliSend(a, send),
      foreignInbox: cli.cliInbox(b, { ...inbox, ackItemIds: [itemId] }),
      foreignSend: cli.cliSend(b, send),
      nonMemberInbox: cli.cliInbox(b, { projectId: p2 }),
      nonMemberSend: cli.cliSend(a, {
        ...send,
        projectId: p2,
        sessionId: otherProject,
      }),
      badAck: cli.cliInbox(a, {
        ...inbox,
        ackItemIds: [itemId, "inb_missing"],
      }),
      newSessionAck: cli.cliInbox(a, { projectId: p1, ackItemIds: [itemId] }),
      badLimit: cli.cliInbox(a, { projectId: p1, limit: 0 }),
      wrongProjectInbox: cli.cliInbox(a, { ...inbox, projectId: p2 }),
      secretText: cli.cliSend(a, { ...send, text: "xoxb-" + "a".repeat(24) }),
    }).toMatchObject({
      disabledInbox: refused("BLOCK_DISABLED"),
      disabledSend: refused("BLOCK_DISABLED"),
      foreignInbox: refused("SESSION_NOT_YOURS"),
      foreignSend: refused("SESSION_NOT_YOURS"),
      nonMemberInbox: refused("NOT_PROJECT_MEMBER"),
      nonMemberSend: refused("NOT_PROJECT_MEMBER"),
      badAck: refused("ACK_INVALID"),
      newSessionAck: refused("ACK_INVALID"),
      badLimit: {
        ok: false,
        error: { code: "INPUT_INVALID", pointer: "/limit" },
      },
      wrongProjectInbox: {
        ok: false,
        error: { code: "INPUT_INVALID", pointer: "/projectId" },
      },
      secretText: {
        ok: false,
        error: { code: "SECRET_IN_TEXT", pointer: "/text" },
      },
    });
    expect(f.rows("inbox_items")).toEqual(beforeItems);
    expect(f.rows("sessions")).toEqual(beforeSessions);
    expectNoApproval(f);
  },
  timeout,
);

function draft(sessionId: string): CliSendInput {
  return { sessionId, projectId: p1, toPersonId: b.personId, text: "CLI note" };
}

test(
  "R1 CLI send redirects a stale child to its live parent and notifies that parent",
  async () => {
    const f = await baseFixture({ ring: true });
    const cli = createCli(f.context);
    const { sessionId } = f.unbound({ projectId: p1 });
    const parent = f.unbound({ projectId: p1 }, b).sessionId;
    const child = f.unbound(
      { projectId: p1, parentSessionId: parent },
      b,
    ).sessionId;
    f.advance(LIMITS.liveSessionMs + 1);
    value(cli.cliInbox(b, { projectId: p1, sessionId: parent }));

    const { itemId } = value(
      await cli.cliSend(a, { ...draft(sessionId), targetSessionId: child }),
    );
    expect({
      rows: f.rows(
        "inbox_items",
        "item_id, target_session_id, for_subagent_session_id",
      ),
      rings: f.rings,
      items: value(cli.cliInbox(b, { projectId: p1, sessionId: parent })).items,
    }).toMatchObject({
      rows: [
        {
          item_id: itemId,
          target_session_id: parent,
          for_subagent_session_id: child,
        },
      ],
      rings: [{ person: b.personId, session: parent, items: [itemId] }],
      items: [{ itemId, forSubagentSessionId: child, trust: "cli" }],
    });
  },
  timeout,
);

test(
  "R2 CLI send refuses explicit targets without the requested project",
  async () => {
    const f = await baseFixture();
    const cli = createCli(f.context);
    const { sessionId } = f.unbound({ projectId: p1 });
    const projectless = f.unbound({}, b).sessionId;
    const otherProject = f.unbound({}, b).sessionId;
    f.db
      .prepare("UPDATE sessions SET project_id = ? WHERE session_id = ?")
      .run(p2, otherProject);
    const input = draft(sessionId);

    expect({
      projectless: await cli.cliSend(a, {
        ...input,
        targetSessionId: projectless,
      }),
      otherProject: await cli.cliSend(a, {
        ...input,
        targetSessionId: otherProject,
      }),
      items: f.rows("inbox_items"),
    }).toMatchObject({
      projectless: { ok: false, error: { code: "SESSION_UNKNOWN" } },
      otherProject: { ok: false, error: { code: "SESSION_UNKNOWN" } },
      items: [],
    });
  },
  timeout,
);

test(
  "R3 CLI send waits for the doorbell ring to settle",
  async () => {
    const f = await baseFixture();
    const { sessionId } = f.unbound({ projectId: p1 });
    const ring = Promise.withResolvers<DoorbellResult>();
    let ringing = false;
    const cli = createCli(
      createCoreContext({
        ...f.deps,
        doorbell: {
          configured: () => true,
          ring: () => {
            ringing = true;
            return ring.promise;
          },
        },
      }),
    );
    let settled = false;
    const send = Promise.resolve(cli.cliSend(a, draft(sessionId))).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whileHeld = { ringing, settled };
    ring.resolve({ kind: "sent", status: 202 });
    const sent = await send;

    expect(whileHeld).toEqual({ ringing: true, settled: false });
    expect(sent.ok).toBe(true);
    expect(f.col("doorbell_rings", "outcome")).toEqual(["sent"]);
  },
  timeout,
);

test(
  "R4 CLI refuses malformed acknowledgement IDs and missing message text",
  async () => {
    const f = await baseFixture();
    const cli = createCli(f.context);
    const { sessionId } = f.unbound({ projectId: p1 });
    const sessions = f.rows("sessions");
    f.advance(1);
    const inbox = {
      sessionId,
      projectId: p1,
      ackItemIds: "inb_invalid",
    } as unknown as CliInboxInput;
    const { text: _text, ...withoutText } = draft(sessionId);
    const malformedSend = withoutText as CliSendInput;
    const threw = (error: unknown) => ({
      threw: error instanceof Error ? error.name : String(error),
    });

    expect({
      inbox: await Promise.resolve()
        .then(() => cli.cliInbox(a, inbox))
        .catch(threw),
      send: await Promise.resolve()
        .then(() => cli.cliSend(a, malformedSend))
        .catch(threw),
    }).toMatchObject({
      inbox: {
        ok: false,
        error: { code: "INPUT_INVALID", pointer: "/ackItemIds" },
      },
      send: { ok: false, error: { code: "INPUT_INVALID", pointer: "/text" } },
    });
    expect(f.rows("sessions")).toEqual(sessions);
    expect(f.rows("inbox_items")).toEqual([]);
  },
  timeout,
);

test(
  "R5 CLI send refuses a removed sender while the recipient is still a project member",
  async () => {
    const f = await baseFixture({ ring: true });
    const cli = createCli(f.context);
    const { sessionId } = f.unbound({ projectId: p1 });
    const targetSessionId = f.unbound({ projectId: p1 }, b).sessionId;
    const sessions = f.rows("sessions");
    f.advance(1);
    f.db
      .prepare(
        "DELETE FROM project_members WHERE project_id = ? AND person_id = ?",
      )
      .run(p1, a.personId);
    expect(f.context.store.sessions.isMember(p1, b.personId)).toBe(true);
    expect(
      await cli.cliSend(a, { ...draft(sessionId), targetSessionId }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_PROJECT_MEMBER" },
    });
    expect(f.rows("sessions")).toEqual(sessions);
    expect(f.rows("inbox_items")).toEqual([]);
    expect(f.rings).toEqual([]);
  },
  timeout,
);
