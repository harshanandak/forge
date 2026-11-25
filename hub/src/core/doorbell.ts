import type { ChatMessageRef, ChatPort } from "../contract/chat.ts";
import type { Conversation, Person } from "../contract/domain.ts";
import type { DoorbellPayload } from "../contract/hooks.ts";
import { ID_PATTERN } from "../contract/ids.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { recordThread } from "./thread.ts";

export type Notice = {
  person: Person;
  projectId: string;
  session?: string;
  conversation?: Conversation;
  items: readonly string[];
  answers: readonly string[];
};

export async function bestEffort(
  ctx: CoreContext,
  call: () => Promise<unknown>,
) {
  try {
    await call();
  } catch {
    ctx.deps.log.warn("chat_notice_failed");
  }
}

export function postNotice(
  chat: ChatPort,
  ref: Pick<ChatMessageRef, "chatThreadId">,
  text: string,
) {
  return chat.postText(
    { kind: "thread", chatThreadId: ref.chatThreadId },
    text,
  );
}

export async function notify(ctx: CoreContext, request: Notice): Promise<void> {
  const { db, now, doorbell, log } = ctx.deps;
  const { person, projectId, session, conversation, items, answers } = request;
  const personId = person.personId;
  if (ctx.waiters.wake(personId, projectId, session)) return;
  const configured = doorbell.configured(personId, projectId);
  const { chat } = ctx;
  if (!configured && (!chat || !conversation)) return;
  const time = now();
  const ring = ctx.store.newId("ring");
  const payload: DoorbellPayload = {
    v: 1,
    ring,
    person: personId,
    project: projectId,
    items,
    answers,
    ...(session === undefined ? {} : { session }),
    ...(conversation ? { conversation: conversation.conversationId } : {}),
  };
  if (
    ![
      ring,
      personId,
      projectId,
      ...items,
      ...answers,
      ...(session ? [session] : []),
      ...(conversation ? [conversation.conversationId] : []),
    ].every((id) => ID_PATTERN.test(id))
  )
    return;
  const claimed = ctx.store.tx(() => {
    const previous = configured
      ? db
          .prepare(
            "SELECT 1 FROM doorbell_rings WHERE person_id=? AND project_id=? AND sent_at>? AND outcome!='not_configured'",
          )
          .get(personId, projectId, time - LIMITS.doorbellDebounceMs)
      : db
          .prepare(
            `SELECT 1 FROM doorbell_rings WHERE outcome='not_configured' AND person_id=? AND sent_at>?
          AND json_extract(ids_json,'$.conversation')=?`,
          )
          .get(
            personId,
            time - 3_600_000,
            conversation?.conversationId ?? null,
          );
    if (previous) return false;
    if (!configured) {
      const live =
        session !== undefined
          ? db
              .prepare(
                `SELECT 1 FROM sessions WHERE session_id=? AND last_seen_at>=?`,
              )
              .get(session, time - LIMITS.liveSessionMs)
          : db
              .prepare(
                `SELECT 1 FROM sessions WHERE person_id=? AND (project_id IS NULL OR project_id=?)
      AND last_seen_at>=?`,
              )
              .get(personId, projectId, time - LIMITS.liveSessionMs);
      if (live) return false;
    }
    db.prepare(
      `INSERT INTO doorbell_rings (ring_id,person_id,project_id,session_id,ids_json,sent_at,outcome)
      VALUES (?,?,?,?,?,?,?)`,
    ).run(
      ring,
      personId,
      projectId,
      session ?? null,
      JSON.stringify(payload),
      time,
      configured ? "failed" : "not_configured",
    );
    return true;
  });
  if (!claimed) return;
  if (configured) {
    try {
      const result = await doorbell.ring(payload);
      ctx.store.tx(() =>
        db
          .prepare(
            "UPDATE doorbell_rings SET outcome=?,http_status=? WHERE ring_id=?",
          )
          .run(
            result.kind,
            "status" in result ? (result.status ?? null) : null,
            ring,
          ),
      );
    } catch {
      log.warn("doorbell_failed", { personId, projectId });
    }
  } else if (chat && conversation) {
    const stale =
      session !== undefined &&
      ctx.store.sessions.session(session) !== undefined;
    const text =
      "Queued for " +
      person.displayName +
      "'s agent." +
      (stale ? " It is offline and will see this when it reconnects." : "");
    await bestEffort(ctx, async () => {
      const ref = await postNotice(chat, conversation, text);
      if (!conversation.isDirect)
        ctx.store.tx(() =>
          recordThread(
            ctx,
            {
              ...ref,
              chatThreadId: conversation.chatThreadId,
              channelId: conversation.channelId,
            },
            projectId,
            "system",
            text,
          ),
        );
    });
  }
}
