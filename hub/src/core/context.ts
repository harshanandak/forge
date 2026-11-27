import type { Conversation, InboxItem, Session } from "../contract/domain.ts";
import { SECRET_PATTERNS, SECRET_REMOVED_TEXT } from "../contract/errors.ts";
import {
  LIMITS,
  THREAD_CONTEXT_NOTICE,
  type ThreadContext,
  type ThreadContextEntry,
} from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { isUnconfirmedMessage, num, str } from "./thread.ts";

export function deliveryContext(
  ctx: CoreContext,
  chat: Conversation,
  item: InboxItem,
  session: Session,
  delivered: boolean,
): ThreadContext | undefined {
  const { db, now } = ctx.deps;
  if (!delivered)
    db.prepare(
      `INSERT INTO reply_owed(item_id,session_id,conversation_id,created_at)
      VALUES (?,?,?,?) ON CONFLICT(item_id) DO NOTHING`,
    ).run(item.itemId, session.sessionId, chat.conversationId, now());
  if (chat.isDirect || item.chatMessageId === undefined) return;
  const range = delivered
    ? db
        .prepare(
          "SELECT context_from_seq AS first, context_to_seq AS last FROM inbox_items WHERE item_id = ?",
        )
        .get(item.itemId)
    : db
        .prepare(
          `SELECT c.context_seq AS first, t.seq AS last FROM conversations c
        JOIN thread_messages t ON t.adapter = c.adapter AND t.chat_thread_id = c.chat_thread_id
        WHERE c.conversation_id = ? AND t.chat_message_id = ?`,
        )
        .get(chat.conversationId, item.chatMessageId);
  if (!range || range.first === null || range.last === null)
    return { entries: [] };
  const first = num(range.first);
  const last = num(range.last);
  const rows = db
    .prepare(
      `SELECT t.*,p.display_name,count(*) OVER () AS eligible FROM thread_messages t
    LEFT JOIN people p ON p.person_id=t.person_id WHERE t.adapter = 'slack' AND t.chat_thread_id = ?
    AND t.seq > ? AND t.seq < ? AND t.deleted = 0 AND t.kind IN ('person','agent','outsider')
    AND NOT (t.kind = 'agent' AND t.person_id = ?)
    ORDER BY t.seq DESC LIMIT ?`,
    )
    .all(chat.chatThreadId, first, last, chat.personId, LIMITS.contextMessages);
  const entries: ThreadContextEntry[] = [];
  let chars = 0;
  for (const row of rows) {
    const { kind } = row;
    if (kind !== "person" && kind !== "agent" && kind !== "outsider")
      throw new Error("Invalid context sender");
    const raw = str(row.text);
    const text = SECRET_PATTERNS.some((pattern) => pattern.test(raw))
      ? SECRET_REMOVED_TEXT
      : raw;
    chars += text.length;
    if (chars > LIMITS.contextChars) break;
    const name =
      kind === "outsider" ? "a person outside Forge" : str(row.display_name);
    const suffix = isUnconfirmedMessage(row.chat_message_id)
      ? " (delivery unconfirmed)"
      : "";
    entries.push({
      from: (kind === "agent" ? name + "'s agent" : name) + suffix,
      senderKind: kind,
      text,
      notYourOwner: kind !== "person" || row.person_id !== chat.personId,
      at: new Date(num(row.created_at)).toISOString(),
      mentionedBot: num(row.mentioned_bot) === 1,
    });
  }
  if (!delivered) {
    const oldest = rows[entries.length - 1];
    const after = (oldest ? num(oldest.seq) : last) - 1;
    db.prepare(
      "UPDATE conversations SET context_seq = max(context_seq, ?) WHERE conversation_id = ?",
    ).run(last, chat.conversationId);
    db.prepare(
      "UPDATE inbox_items SET context_from_seq = ?,context_to_seq = ? WHERE item_id = ?",
    ).run(after, last, item.itemId);
  }
  const omitted = rows[0] ? num(rows[0].eligible) - entries.length : 0;
  return {
    entries: entries.reverse(),
    ...(omitted ? { omitted } : {}),
    ...(entries.length ? { notice: THREAD_CONTEXT_NOTICE } : {}),
  };
}
