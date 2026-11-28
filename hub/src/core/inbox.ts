import type { Caller, HubResult } from "../contract/core.ts";
import type { InboxItem, Session } from "../contract/domain.ts";
import type { HubErrorCode } from "../contract/errors.ts";
import {
  AGENT_MESSAGE_NOTICE,
  CLI_MESSAGE_NOTICE,
  LIMITS,
  NOT_YOUR_OWNER_NOTICE,
  type InboxInput,
  type InboxItemView,
  type InboxOutput,
} from "../contract/mcp.ts";
import { deliveryContext } from "./context.ts";
import type { CoreContext } from "./core.ts";
import { fail } from "./errors.ts";
import { byConversation } from "./thread.ts";

export const refused = (code: HubErrorCode, pointer?: string) =>
  ({ ok: false, error: fail(code, pointer) }) as const;

function acknowledge(ctx: CoreContext, session: Session, input: InboxInput) {
  const { db, now } = ctx.deps;
  const { sessionId, personId, projectId } = session;
  const items = input.ackItemIds ?? [];
  const answers = input.ackAskIds ?? [];
  const item =
    db.prepare(`SELECT 1 FROM inbox_items i WHERE item_id = ? AND delivered_to_session_id = ?
    AND owner_person_id = ? AND held = 0 AND i.project_id IS COALESCE(?, i.project_id)
    AND (project_id IS NULL OR EXISTS (
      SELECT 1 FROM project_members m WHERE m.project_id = i.project_id AND m.person_id = i.owner_person_id))`);
  const answer =
    db.prepare(`SELECT 1 FROM ask_answers x JOIN asks a ON a.ask_id = x.ask_id
    JOIN project_members m ON m.project_id = a.project_id AND m.person_id = a.from_person_id
    WHERE x.ask_id = ? AND a.from_session_id = ? AND a.from_person_id = ?
    AND x.delivered_at IS NOT NULL`);
  if (
    items.some((id) => !item.get(id, sessionId, personId, projectId ?? null)) ||
    answers.some(
      (id) => !ctx.store.asks || !answer.get(id, sessionId, personId),
    )
  )
    return false;
  for (const id of items)
    db.prepare(
      "UPDATE inbox_items SET acked_at = ? WHERE item_id = ? AND acked_at IS NULL",
    ).run(now(), id);
  for (const id of answers)
    db.prepare(
      "UPDATE ask_answers SET acked_at = ? WHERE ask_id = ? AND acked_at IS NULL",
    ).run(now(), id);
  return true;
}

function itemView(
  ctx: CoreContext,
  item: InboxItem,
  session: Session,
  redelivered: boolean,
): InboxItemView {
  const { db, config, now } = ctx.deps;
  const chat = item.conversationId && byConversation(db, item.conversationId);
  const project =
    chat && config.projects.find((entry) => entry.projectId === item.projectId);
  const threadContext =
    ctx.chat && chat
      ? deliveryContext(ctx, chat, item, session, redelivered)
      : undefined;
  if (!redelivered) {
    db.prepare(
      "UPDATE inbox_items SET delivered_at = ?,delivered_to_session_id = ? WHERE item_id = ?",
    ).run(now(), session.sessionId, item.itemId);
    if (chat)
      db.prepare(
        "UPDATE conversations SET session_id = ? WHERE conversation_id = ? AND session_id IS NULL",
      ).run(session.sessionId, chat.conversationId);
    if (
      item.notYourOwner ||
      threadContext?.entries.some((entry) => entry.notYourOwner)
    )
      ctx.store.sessions.markUntrustedRead(session.sessionId);
  }
  const { sender } = item;
  const trust =
    sender.kind === "person"
      ? item.notYourOwner
        ? "not_your_owner"
        : "owner"
      : sender.kind;
  const notice =
    trust === "not_your_owner"
      ? NOT_YOUR_OWNER_NOTICE
      : trust === "agent"
        ? AGENT_MESSAGE_NOTICE
        : trust === "cli"
          ? CLI_MESSAGE_NOTICE
          : undefined;
  return {
    itemId: item.itemId,
    text: item.text,
    kind: item.kind,
    trust,
    redelivered,
    receivedAt: new Date(item.receivedAt).toISOString(),
    audience: chat && !chat.isDirect ? "channel" : "dm",
    from:
      sender.kind === "system"
        ? { kind: "system", name: "Forge" }
        : {
            kind: sender.kind,
            personId: sender.personId,
            name: sender.displayName,
            ...("sessionId" in sender ? { sessionId: sender.sessionId } : {}),
          },
    ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
    ...(item.conversationId === undefined
      ? {}
      : { conversationId: item.conversationId }),
    ...(item.forSubagentSessionId === undefined
      ? {}
      : { forSubagentSessionId: item.forSubagentSessionId }),
    ...(project
      ? {
          projectName: project.name,
          ...(project.purpose === undefined
            ? {}
            : { projectPurpose: project.purpose }),
        }
      : {}),
    ...(notice === undefined ? {} : { notice }),
    ...(threadContext === undefined ? {} : { threadContext }),
  };
}

export function delivery(
  ctx: CoreContext,
  caller: Caller,
  input: InboxInput,
  options?: { token?: boolean; signal?: AbortSignal },
): HubResult<InboxOutput> {
  const { tx, sessions, asks, credentials } = ctx.store;
  const { db, now } = ctx.deps;
  const limit = input.limit ?? LIMITS.inboxDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.inboxMax)
    return refused("INPUT_INVALID", "/limit");
  return tx(() => {
    if (options?.token && !credentials.isTokenCurrent(caller.tokenId))
      return refused("UNAUTHENTICATED");
    const session = sessions.session(input.sessionId);
    if (!session) return refused("SESSION_UNKNOWN");
    if (session.personId !== caller.person.personId)
      return refused("SESSION_NOT_YOURS");
    if (!acknowledge(ctx, session, input)) return refused("ACK_INVALID");
    sessions.requireOwnSession(caller.person, input.sessionId);
    if (options?.signal?.aborted)
      return {
        ok: true,
        value: { items: [], answers: [], mode: session.mode, more: false },
      };
    const pending = sessions.outstanding(session, limit + 1);
    const fresh = sessions.deliverable(session, limit + 1 - pending.length);
    const items = [...pending, ...fresh]
      .slice(0, limit)
      .map((item) =>
        itemView(ctx, item, session, item.deliveredAt !== undefined),
      );
    const answerRows = asks?.answerRows(session.sessionId, limit + 1) ?? [];
    const answers = answerRows.slice(0, limit).map(({ view, delivered }) => {
      if (!delivered)
        db.prepare(
          "UPDATE ask_answers SET delivered_at = ? WHERE ask_id = ?",
        ).run(now(), view.askId);
      return view;
    });
    return {
      ok: true,
      value: {
        items,
        answers,
        more:
          pending.length + fresh.length > limit || answerRows.length > limit,
        mode: sessions.session(session.sessionId)?.mode ?? session.mode,
      },
    };
  });
}
