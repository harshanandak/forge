import type {
  ChatMessageChangeEvent,
  ChatMessageEvent,
  ChatMessageRef,
} from "../contract/chat.ts";
import type { Conversation } from "../contract/domain.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { HubDb, SqlRow } from "../contract/runtime.ts";
import type { CoreContext } from "./core.ts";

export function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid hub text column");
  return value;
}

export function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Invalid hub integer column");
  return value;
}

export function conversation(row: SqlRow): Conversation {
  const createdBy = row.created_by;
  if (createdBy !== "agent" && createdBy !== "slack")
    throw new Error("Invalid conversation source");
  return {
    conversationId: str(row.conversation_id),
    personId: str(row.person_id),
    adapter: "slack",
    chatThreadId: str(row.chat_thread_id),
    channelId: str(row.channel_id),
    isDirect: num(row.is_direct) === 1,
    createdBy,
    createdAt: num(row.created_at),
    ...(row.project_id === null ? {} : { projectId: str(row.project_id) }),
    ...(row.session_id === null ? {} : { sessionId: str(row.session_id) }),
  };
}

export function byConversation(db: HubDb, id: string) {
  const row = db
    .prepare("SELECT * FROM conversations WHERE conversation_id = ?")
    .get(id);
  return row && conversation(row);
}

export function messageText(
  ctx: CoreContext,
  event: Pick<ChatMessageEvent, "text" | "fileNames">,
) {
  return ctx.store.guards.storedText(
    [event.text, ...event.fileNames.map((name) => "[file] " + name)].join("\n"),
  );
}

export function changed(ctx: CoreContext, event: ChatMessageChangeEvent): void {
  const deleted = event.kind === "deleted";
  ctx.store.tx(() =>
    ctx.deps.db
      .prepare(
        `UPDATE thread_messages
    SET text = ?, edited_at = CASE WHEN ? = 0 THEN ? ELSE edited_at END, deleted = ?
    WHERE adapter = 'slack' AND chat_thread_id = ? AND channel_id = ?
      AND chat_message_id = ? AND kind = 'person' AND deleted = 0`,
      )
      .run(
        deleted ? "" : messageText(ctx, event),
        Number(deleted),
        ctx.deps.now(),
        Number(deleted),
        event.chatThreadId,
        event.channelId,
        event.chatMessageId,
      ),
  );
}

export function recordThread(
  ctx: CoreContext,
  ref: ChatMessageRef,
  projectId: string,
  kind: "person" | "outsider" | "system",
  text: string,
  personId?: string,
  mentionedBot = false,
) {
  return (
    ctx.deps.db
      .prepare(
        `INSERT INTO thread_messages
    (adapter,chat_thread_id,channel_id,project_id,chat_message_id,kind,text,person_id,mentioned_bot,created_at)
    VALUES ('slack',?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(
        ref.chatThreadId,
        ref.channelId,
        projectId,
        ref.chatMessageId,
        kind,
        text,
        personId ?? null,
        Number(mentionedBot),
        ctx.deps.now(),
      ).changes !== 0
  );
}

export function recordAgentPost(
  ctx: CoreContext,
  ref: ChatMessageRef,
  conversation: Conversation,
  sessionId: string,
  personId: string,
  text: string,
) {
  if (conversation.isDirect || conversation.projectId === undefined)
    return false;
  return (
    ctx.deps.db
      .prepare(
        `INSERT INTO thread_messages
    (adapter,chat_thread_id,channel_id,project_id,chat_message_id,kind,text,person_id,session_id,created_at)
    VALUES ('slack',?,?,?,?,?,'agent',?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(
        conversation.chatThreadId,
        conversation.channelId,
        conversation.projectId,
        ref.chatMessageId,
        text,
        personId,
        sessionId,
        ctx.deps.now(),
      ).changes !== 0
  );
}

export function paused(db: HubDb, thread: string): boolean {
  const rows = db
    .prepare(
      `SELECT kind FROM thread_messages WHERE adapter = 'slack'
    AND chat_thread_id = ? AND kind IN ('agent','person') ORDER BY seq DESC LIMIT ?`,
    )
    .all(thread, LIMITS.agentRunMax);
  return (
    rows.length === LIMITS.agentRunMax &&
    rows.every(({ kind }) => kind === "agent")
  );
}
