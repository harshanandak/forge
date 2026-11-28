import { randomUUID } from "node:crypto";
import type { ChatMessageRef } from "../contract/chat.ts";
import type { Conversation } from "../contract/domain.ts";
import { redactSecretText } from "../contract/errors.ts";
import type { HubDb } from "../contract/runtime.ts";
import type { CoreContext } from "./core.ts";
import { recordAgentPost, UNCONFIRMED_MESSAGE_PREFIX } from "./thread.ts";

type Reservation = {
  id: string;
  conversation: Conversation;
  sessionId: string;
  personId: string;
  text: string;
  at: number;
};

type Outcome =
  | { phase: "confirmed"; ref: ChatMessageRef }
  | { phase: "refused" | "unknown" };

export type SettledAgentPost = Reservation & Outcome;
type JournalPost = Reservation & (Outcome | { phase: "reserved" });

export class AgentPostOutcomeError extends Error {}

export class AgentPostJournalError extends Error {
  readonly key: string;

  constructor(key: string) {
    super("Invalid agent post journal row");
    this.name = "AgentPostJournalError";
    this.key = key;
  }
}

export const AGENT_POST_JOURNAL_PREFIX = "agent-post:";
const journalKey = (thread: string) => AGENT_POST_JOURNAL_PREFIX + thread;

type JournalRead =
  { readonly ok: true; readonly post: JournalPost } | { readonly ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCreatedBy(value: unknown): value is Conversation["createdBy"] {
  return value === "slack" || value === "telegram" || value === "agent";
}

function validJournalTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validConversation(value: unknown): value is Conversation {
  if (!isRecord(value)) return false;
  if (typeof value.conversationId !== "string") return false;
  if (typeof value.personId !== "string") return false;
  if (value.adapter !== "slack") return false;
  if (typeof value.chatThreadId !== "string") return false;
  if (typeof value.channelId !== "string") return false;
  if (value.isDirect !== false) return false;
  if (!validCreatedBy(value.createdBy)) return false;
  if (!validJournalTime(value.createdAt)) return false;
  if (typeof value.projectId !== "string") return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string")
    return false;
  return true;
}

function validRef(value: unknown): value is ChatMessageRef {
  return (
    isRecord(value) &&
    typeof value.chatThreadId === "string" &&
    typeof value.chatMessageId === "string" &&
    typeof value.channelId === "string"
  );
}

function readJournalPost(key: string, value: unknown): JournalRead {
  if (!key.startsWith(AGENT_POST_JOURNAL_PREFIX) || typeof value !== "string")
    return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false };
  }
  if (!isRecord(parsed)) return { ok: false };
  const phase = parsed.phase;
  if (
    phase !== "reserved" &&
    phase !== "confirmed" &&
    phase !== "refused" &&
    phase !== "unknown"
  )
    return { ok: false };
  const id = parsed.id;
  const conversation = parsed.conversation;
  const sessionId = parsed.sessionId;
  const personId = parsed.personId;
  const text = parsed.text;
  const at = parsed.at;
  if (typeof id !== "string") return { ok: false };
  if (!validConversation(conversation)) return { ok: false };
  if (conversation.chatThreadId !== key.slice(AGENT_POST_JOURNAL_PREFIX.length))
    return { ok: false };
  if (typeof sessionId !== "string") return { ok: false };
  if (typeof personId !== "string") return { ok: false };
  if (typeof text !== "string") return { ok: false };
  if (!validJournalTime(at)) return { ok: false };
  const reservation = {
    id,
    conversation,
    sessionId,
    personId,
    text: redactSecretText(text),
    at,
  };
  if (phase === "confirmed") {
    const ref = parsed.ref;
    if (!validRef(ref)) return { ok: false };
    return { ok: true, post: { ...reservation, phase, ref } };
  }
  return { ok: true, post: { ...reservation, phase } };
}

export function unresolvedAgentPost(db: HubDb) {
  const unconfirmed = db.prepare(`
    SELECT 1 FROM thread_messages WHERE session_id = ?
      AND (? IS NULL OR project_id IS NOT ?)
      AND kind = 'agent' AND chat_message_id LIKE ? LIMIT 1
  `);
  const journal = db.prepare(
    "SELECT key,value FROM meta WHERE key GLOB 'agent-post:*'",
  );
  return (sessionId: string, projectId: string | null) =>
    !!unconfirmed.get(
      sessionId,
      projectId,
      projectId,
      UNCONFIRMED_MESSAGE_PREFIX + "%",
    ) ||
    journal.all().some((row) => {
      const read = readJournalPost(String(row.key), row.value);
      return (
        !read.ok ||
        (read.post.sessionId === sessionId &&
          (projectId === null ||
            read.post.conversation.projectId !== projectId) &&
          read.post.phase !== "refused")
      );
    });
}

export function reserveAgentPost(
  ctx: CoreContext,
  conversation: Conversation,
  sessionId: string,
  personId: string,
  text: string,
) {
  if (conversation.isDirect || conversation.projectId === undefined) return;
  const post = {
    id: UNCONFIRMED_MESSAGE_PREFIX + randomUUID(),
    conversation,
    sessionId,
    personId,
    text,
    at: ctx.deps.now(),
    phase: "reserved",
  };
  ctx.deps.db
    .prepare("INSERT INTO meta (key,value) VALUES (?,?)")
    .run(journalKey(conversation.chatThreadId), JSON.stringify(post));
  return post;
}

function writeOutcome(ctx: CoreContext, post: SettledAgentPost) {
  const { changes } = ctx.deps.db
    .prepare("UPDATE meta SET value = ? WHERE key = ?")
    .run(JSON.stringify(post), journalKey(post.conversation.chatThreadId));
  if (Number(changes) !== 1) throw new Error("Agent post reservation missing");
}

function storedRead(
  ctx: CoreContext,
  thread: string,
): { readonly key: string; readonly read: JournalRead } | undefined {
  const key = journalKey(thread);
  const row = ctx.deps.db
    .prepare("SELECT value FROM meta WHERE key=?")
    .get(key);
  if (!row) return undefined;
  return { key, read: readJournalPost(key, row.value) };
}

function projectPost(ctx: CoreContext, key: string, post: JournalPost) {
  const { conversation } = post;
  ctx.store.tx(() => {
    if (post.phase !== "refused")
      recordAgentPost(
        ctx,
        post.phase === "confirmed"
          ? post.ref
          : { ...conversation, chatMessageId: post.id },
        conversation,
        post.sessionId,
        post.personId,
        post.text,
        post.at,
      );
    ctx.deps.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  });
}

export function settleAgentPost(
  ctx: CoreContext,
  reservation: Reservation,
  outcome: Outcome,
): boolean {
  const post = { ...reservation, ...outcome };
  for (const retry of [true, false]) {
    try {
      writeOutcome(ctx, post);
      break;
    } catch (cause) {
      if (retry) continue;
      ctx.pendingAgentPosts.set(post.conversation.chatThreadId, post);
      throw new AgentPostOutcomeError("Journal write failed", { cause });
    }
  }
  try {
    projectPost(ctx, journalKey(post.conversation.chatThreadId), post);
    return true;
  } catch {
    ctx.deps.log.warn("agent_post_projection_failed");
    return false;
  }
}

export function agentPost(ctx: CoreContext, thread: string) {
  const stored = storedRead(ctx, thread);
  if (!stored) return ctx.pendingAgentPosts.get(thread);
  if (!stored.read.ok) throw new AgentPostJournalError(stored.key);
  return ctx.pendingAgentPosts.get(thread) ?? stored.read.post;
}

export function recoverAgentPosts(ctx: CoreContext, thread?: string) {
  if (thread !== undefined) {
    const stored = storedRead(ctx, thread);
    if (stored && !stored.read.ok) throw new AgentPostJournalError(stored.key);
    const pending = ctx.pendingAgentPosts.get(thread);
    if (pending) {
      writeOutcome(ctx, pending);
      ctx.pendingAgentPosts.delete(thread);
    }
    const post = pending ?? agentPost(ctx, thread);
    if (!post) return;
    projectPost(ctx, journalKey(thread), post);
    return post.conversation;
  }
  const rows = ctx.deps.db
    .prepare("SELECT key,value FROM meta WHERE key GLOB 'agent-post:*'")
    .all();
  for (const row of rows) {
    const key = String(row.key);
    const read = readJournalPost(key, row.value);
    if (!read.ok) {
      ctx.deps.log.warn("agent_post_journal_invalid", { key });
      continue;
    }
    try {
      projectPost(ctx, key, read.post);
    } catch {
      ctx.deps.log.warn("agent_post_journal_projection_failed", { key });
    }
  }
}
