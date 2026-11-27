import type { HubCore } from "../contract/core.ts";
import { HOOK_STOP_TEXT_MAX } from "../contract/hooks.ts";
import { LIMITS } from "../contract/mcp.ts";
import { agentPost, AgentPostJournalError } from "./agent-posts.ts";
import type { CoreContext } from "./core.ts";
import { refused } from "./inbox.ts";
import { str, UNCONFIRMED_MESSAGE_PREFIX } from "./thread.ts";

const heldNotice =
  "The agent's final message looked like it contained a secret and was held.";
const skipped = { ok: true, value: { result: "skipped" } } as const;

export function createStop(
  ctx: CoreContext,
  reply: HubCore["reply"],
): HubCore["hookStop"] {
  const {
    chat,
    deps: { config, db },
    store: { guards, sessions, tx },
    pendingAgentPosts,
    threadGates,
  } = ctx;
  const delivered = `EXISTS (SELECT 1 FROM inbox_items AS i
    WHERE i.item_id = reply_owed.item_id AND i.delivered_to_session_id = reply_owed.session_id)`;
  const owed = db.prepare(
    `SELECT DISTINCT conversation_id, chat_thread_id
     FROM reply_owed JOIN conversations USING (conversation_id)
     WHERE reply_owed.session_id = ? AND answered = 0 AND ${delivered} LIMIT 2`,
  );
  const claim = db.prepare(
    `UPDATE reply_owed SET answered = 1
     WHERE session_id = ? AND conversation_id = ? AND answered = 0
     AND ${delivered}
     RETURNING item_id`,
  );
  const restore = db.prepare(
    `UPDATE reply_owed SET answered = 0
     WHERE session_id = ? AND conversation_id = ?
     AND item_id IN (SELECT value FROM json_each(?))`,
  );
  const unconfirmed = db.prepare(
    `SELECT 1 FROM thread_messages WHERE adapter = 'slack' AND kind = 'agent'
     AND chat_message_id LIKE ? AND (chat_thread_id = ? OR session_id = ?)
     LIMIT 1`,
  );
  const journalThreads = db.prepare(
    `SELECT substr(key, length('agent-post:') + 1) AS thread FROM meta
     WHERE key GLOB 'agent-post:*' AND CASE WHEN json_valid(value)
     THEN json_extract(value, '$.sessionId') = ? ELSE 0 END`,
  );

  function hasUnresolvedPost(thread: string, sessionId: string): boolean {
    if (unconfirmed.get(UNCONFIRMED_MESSAGE_PREFIX + "%", thread, sessionId))
      return true;
    for (const post of pendingAgentPosts.values()) {
      if (post.sessionId === sessionId && post.phase !== "refused") return true;
    }
    try {
      const threads = new Set([thread]);
      for (const row of journalThreads.all(sessionId))
        threads.add(str(row.thread));
      for (const candidate of threads) {
        const post = agentPost(ctx, candidate);
        if (post && post.phase !== "refused") return true;
      }
      return false;
    } catch (error) {
      if (error instanceof AgentPostJournalError) return true;
      throw error;
    }
  }

  return async (host, input) => {
    if (!config.hooks.enabled) return refused("BLOCK_DISABLED");
    const claimTarget = () =>
      tx(() => {
        const binding = sessions.hookMode(host, input);
        if (!binding.ok) return binding;
        const { sessionId } = binding.value;
        if (sessionId === undefined) return refused("SESSION_UNKNOWN");
        const conversations = owed.all(sessionId);
        const first = conversations[0];
        if (!first || conversations.length !== 1) return skipped;
        if (!chat) return refused("BLOCK_DISABLED");
        const thread = str(first.chat_thread_id);
        const pending = threadGates.get(thread);
        if (pending) return { pending } as const;
        if (hasUnresolvedPost(thread, sessionId)) return skipped;
        const { text } = input;
        if (
          typeof text !== "string" ||
          !text.length ||
          text.length > HOOK_STOP_TEXT_MAX
        )
          return refused("INPUT_INVALID", "/text");
        const error = guards.outboundText(text, "/text");
        const held = error?.code === "SECRET_IN_TEXT";
        if (error && !held) return { ok: false, error } as const;
        const conversationId = str(first.conversation_id);
        const itemIds = claim
          .all(sessionId, conversationId)
          .map((row) => str(row.item_id));
        const safeText = held ? heldNotice : text.slice(0, LIMITS.replyText);
        return {
          ok: true,
          sessionId,
          conversationId,
          itemIds,
          text: safeText,
          held,
        } as const;
      });
    let target = claimTarget();
    while ("pending" in target) {
      await target.pending;
      target = claimTarget();
    }
    if (!target.ok || "value" in target) return target;
    const { sessionId, conversationId, itemIds, text, held } = target;
    const result = await reply(
      { person: host.person, tokenId: "" },
      { sessionId, conversationId, text },
    );
    if (!result.ok) {
      const { retry } = result.error;
      if (retry === "safe" || retry === "never")
        restore.run(sessionId, conversationId, JSON.stringify(itemIds));
      return result;
    }
    return { ok: true, value: { result: held ? "held" : "posted" } };
  };
}
