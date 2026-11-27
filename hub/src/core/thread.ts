import type {
  ChatMessageChangeEvent,
  ChatMessageEvent,
  ChatMessageRef,
} from "../contract/chat.ts";
import type { Conversation } from "../contract/domain.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { HubDb, SqlRow } from "../contract/runtime.ts";
import type { CoreContext } from "./core.ts";
import { fail } from "./errors.ts";

export function channelBindingRefusal(
  db: HubDb,
  conversation: Conversation,
  projectId: string | undefined,
) {
  if (conversation.isDirect) return undefined;
  const row =
    projectId === undefined
      ? undefined
      : db
          .prepare("SELECT slack_channel_id FROM projects WHERE project_id = ?")
          .get(projectId);
  const currentChannel =
    row && typeof row.slack_channel_id === "string"
      ? row.slack_channel_id
      : undefined;
  if (
    conversation.projectId !== projectId ||
    conversation.channelId !== currentChannel
  )
    return {
      ok: false,
      error: fail("INPUT_INVALID", "/conversationId"),
    } as const;
  return undefined;
}

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

export const UNCONFIRMED_MESSAGE_PREFIX = "unconfirmed:";

export function recordAgentPost(
  ctx: CoreContext,
  ref: ChatMessageRef,
  conversation: Conversation,
  sessionId: string,
  personId: string,
  text: string,
  createdAt = ctx.deps.now(),
) {
  if (conversation.isDirect || conversation.projectId === undefined)
    return false;
  return (
    ctx.deps.db
      .prepare(
        `INSERT INTO thread_messages
    (adapter,chat_thread_id,channel_id,project_id,chat_message_id,kind,text,person_id,session_id,created_at)
    VALUES ('slack',?,?,?,?,'agent',?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .run(
        conversation.chatThreadId,
        conversation.channelId,
        conversation.projectId,
        ref.chatMessageId,
        text,
        personId,
        sessionId,
        createdAt,
      ).changes !== 0
  );
}

export function isUnconfirmedMessage(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(UNCONFIRMED_MESSAGE_PREFIX);
}

export const LOOP_PAUSE_TEXT = "Paused: the agents need a person to reply.";

type OrderKey = readonly [string, string];

function tsKey(id: unknown): OrderKey | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^0*(\d+)\.(\d{6})$/.exec(id);
  return match ? [match[1]!, match[2]!] : undefined;
}

function compareKeys(a: OrderKey, b: OrderKey): number {
  return (
    a[0].length - b[0].length ||
    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) ||
    (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
  );
}

function guardState(
  db: HubDb,
  thread: string,
): { readonly paused: boolean; readonly boundarySeq: number } {
  const rows = db
    .prepare(
      `SELECT seq,kind,chat_message_id FROM thread_messages WHERE adapter = 'slack'
    AND chat_thread_id = ? AND kind IN ('agent','person') ORDER BY seq`,
    )
    .all(thread);
  let personKey: OrderKey | undefined;
  let personKeySeq = -1;
  let anyPersonSeq = -1;
  for (const row of rows) {
    if (str(row.kind) !== "person") continue;
    const seq = num(row.seq);
    anyPersonSeq = seq;
    const key = tsKey(row.chat_message_id);
    if (
      key !== undefined &&
      (personKey === undefined || compareKeys(key, personKey) > 0)
    ) {
      personKey = key;
      personKeySeq = seq;
    }
  }
  const boundarySeq = personKey === undefined ? anyPersonSeq : personKeySeq;
  let count = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (str(row.kind) !== "agent") continue;
    const id = row.chat_message_id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const seq = num(row.seq);
    const key = tsKey(id);
    if (key !== undefined && personKey !== undefined) {
      if (compareKeys(key, personKey) > 0) count += 1;
    } else if (seq > boundarySeq) count += 1;
  }
  return { paused: count >= LIMITS.agentRunMax, boundarySeq };
}

export function paused(db: HubDb, thread: string): boolean {
  return guardState(db, thread).paused;
}

export async function enterThread(
  ctx: CoreContext,
  thread: string,
): Promise<() => void> {
  const gates = ctx.threadGates;
  const previous = gates.get(thread) ?? Promise.resolve();
  const { promise: entered, resolve: release } = Promise.withResolvers<void>();
  const queued = previous.then(() => entered);
  gates.set(thread, queued);
  await previous;
  return () => {
    release();
    if (gates.get(thread) === queued) gates.delete(thread);
  };
}

function loopPauseDue(ctx: CoreContext, conversation: Conversation) {
  return ctx.store.tx(() => {
    const state = guardState(ctx.deps.db, conversation.chatThreadId);
    if (!state.paused) return false;
    return (
      ctx.deps.db
        .prepare(
          `SELECT 1 FROM thread_messages WHERE adapter = 'slack' AND chat_thread_id = ? AND kind = 'system' AND text = ? AND seq > ? LIMIT 1`,
        )
        .get(conversation.chatThreadId, LOOP_PAUSE_TEXT, state.boundarySeq) ===
      undefined
    );
  });
}

export async function postLoopPause(ctx: CoreContext, pending: Conversation) {
  const { projectId } = pending;
  if (!ctx.chat || projectId === undefined) return;
  try {
    const db = ctx.deps.db;
    const conversation = byConversation(db, pending.conversationId);
    if (conversation?.chatThreadId !== pending.chatThreadId) return;
    if (channelBindingRefusal(db, conversation, projectId)) return;
    if (!loopPauseDue(ctx, conversation)) return;
    const ref = await ctx.chat.postText(
      { kind: "thread", chatThreadId: conversation.chatThreadId },
      LOOP_PAUSE_TEXT,
    );
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
        LOOP_PAUSE_TEXT,
      ),
    );
  } catch {
    ctx.deps.log.warn("chat_notice_failed");
  }
}
