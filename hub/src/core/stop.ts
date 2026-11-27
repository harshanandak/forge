import type { HubCore } from "../contract/core.ts";
import { HOOK_STOP_TEXT_MAX } from "../contract/hooks.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { refused } from "./inbox.ts";
import { str } from "./thread.ts";

const heldNotice =
  "The agent's final message looked like it contained a secret and was held.";
const skipped = { ok: true, value: { result: "skipped" } } as const;

export function createStop(
  {
    chat,
    deps: { config, db },
    store: { guards, sessions, tx },
    threadGates,
  }: CoreContext,
  reply: HubCore["reply"],
): HubCore["hookStop"] {
  const owed = db.prepare(
    `SELECT DISTINCT conversation_id, chat_thread_id
     FROM reply_owed JOIN conversations USING (conversation_id)
     WHERE reply_owed.session_id = ? AND answered = 0 LIMIT 2`,
  );
  const claim = db.prepare(
    `UPDATE reply_owed SET answered = 1
     WHERE session_id = ? AND conversation_id = ? AND answered = 0`,
  );

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
        const pending = threadGates.get(str(first.chat_thread_id));
        if (pending) return { pending } as const;
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
        claim.run(sessionId, conversationId);
        const safeText = held ? heldNotice : text.slice(0, LIMITS.replyText);
        return {
          ok: true,
          sessionId,
          conversationId,
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
    const { sessionId, conversationId, text, held } = target;
    const result = await reply(
      { person: host.person, tokenId: "" },
      { sessionId, conversationId, text },
    );
    return result.ok
      ? { ok: true, value: { result: held ? "held" : "posted" } }
      : result;
  };
}
