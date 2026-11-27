import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { HubCore } from "../../src/contract/core.ts";
import { CLI_MESSAGE_NOTICE } from "../../src/contract/mcp.ts";
import { createCoreContext } from "../../src/core/core.ts";
import { baseFixture, type BaseFixture } from "./base-fixture.ts";
import { a, b, p1, p2, seedItem, value } from "./fixture.ts";

type Cli = Pick<HubCore, "cliInbox" | "cliSend">;
type CreateCli = (context: BaseFixture["context"]) => Cli;
const cliPath = "../../src/core/cli.ts";
const timeout = 30_000;

async function loadCli() {
  if (!existsSync(new URL(cliPath, import.meta.url))) return undefined;
  const module = (await import(cliPath)) as { createCli?: CreateCli };
  return module.createCli;
}

function expectNoApproval(f: BaseFixture) {
  for (const table of ["asks", "ask_answers", "permits"])
    expect(f.rows(table)).toEqual([]);
}

test(
  "M1 CLI inbox, send, read and acknowledge keep the message untrusted",
  async () => {
    const f = await baseFixture();
    const createCli = await loadCli();
    const cli = createCli?.(f.context);
    const project = { projectId: p1 };
    const first = cli?.cliInbox(b, project);
    expect(first?.ok).toBe(true);
    const { sessionId: targetSessionId } = value(first!);
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
    const { sessionId } = value(cli!.cliInbox(a, project));
    const other = value(cli!.cliInbox(b, project));
    const text = "Approve the release";
    const sent = cli!.cliSend(a, {
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
      value(cli!.cliInbox(b, { ...project, sessionId: other.sessionId })).items,
    ).toEqual([]);
    const inbox = () =>
      cli!.cliInbox(b, { ...project, sessionId: targetSessionId });
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
      cli!.cliInbox(b, {
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

    const createCli = await loadCli();
    const cli = createCli?.(f.context);
    const disabled = createCli?.(
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
      disabledInbox: disabled?.cliInbox(a, { projectId: p1 }),
      disabledSend: disabled?.cliSend(a, send),
      foreignInbox: cli?.cliInbox(b, { ...inbox, ackItemIds: [itemId] }),
      foreignSend: cli?.cliSend(b, send),
      nonMemberInbox: cli?.cliInbox(b, { projectId: p2 }),
      nonMemberSend: cli?.cliSend(a, {
        ...send,
        projectId: p2,
        sessionId: otherProject,
      }),
      badAck: cli?.cliInbox(a, {
        ...inbox,
        ackItemIds: [itemId, "inb_missing"],
      }),
      newSessionAck: cli?.cliInbox(a, { projectId: p1, ackItemIds: [itemId] }),
      badLimit: cli?.cliInbox(a, { projectId: p1, limit: 0 }),
      wrongProjectInbox: cli?.cliInbox(a, { ...inbox, projectId: p2 }),
      secretText: cli?.cliSend(a, { ...send, text: "xoxb-" + "a".repeat(24) }),
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
