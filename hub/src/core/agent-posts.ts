import { randomUUID } from "node:crypto";
import type { ChatMessageRef } from "../contract/chat.ts";
import type { Conversation } from "../contract/domain.ts";
import type { CoreContext } from "./core.ts";
import { recordAgentPost, str, UNCONFIRMED_MESSAGE_PREFIX } from "./thread.ts";

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

const journalPrefix = "agent-post:";

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
    .run(journalPrefix + conversation.chatThreadId, JSON.stringify(post));
  return post;
}

function writeOutcome(ctx: CoreContext, post: SettledAgentPost) {
  const { changes } = ctx.deps.db
    .prepare("UPDATE meta SET value = ? WHERE key = ?")
    .run(JSON.stringify(post), journalPrefix + post.conversation.chatThreadId);
  if (Number(changes) !== 1) throw new Error("Agent post reservation missing");
}

function projectPost(ctx: CoreContext, post: JournalPost) {
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
    ctx.deps.db
      .prepare("DELETE FROM meta WHERE key = ?")
      .run(journalPrefix + conversation.chatThreadId);
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
    projectPost(ctx, post);
    return true;
  } catch {
    ctx.deps.log.warn("agent_post_projection_failed");
    return false;
  }
}

export function agentPost(ctx: CoreContext, thread: string) {
  const pending = ctx.pendingAgentPosts.get(thread);
  if (pending) return pending;
  const row = ctx.deps.db
    .prepare("SELECT value FROM meta WHERE key=?")
    .get(journalPrefix + thread);
  return row && (JSON.parse(str(row.value)) as JournalPost);
}

export function recoverAgentPosts(ctx: CoreContext, thread?: string) {
  if (thread !== undefined) {
    const pending = ctx.pendingAgentPosts.get(thread);
    if (pending) {
      writeOutcome(ctx, pending);
      ctx.pendingAgentPosts.delete(thread);
    }
    const post = pending ?? agentPost(ctx, thread);
    if (!post) return;
    projectPost(ctx, post);
    return post.conversation;
  }
  const rows = ctx.deps.db
    .prepare("SELECT value FROM meta WHERE key GLOB 'agent-post:*'")
    .all();
  for (const row of rows)
    projectPost(ctx, JSON.parse(str(row.value)) as JournalPost);
}
