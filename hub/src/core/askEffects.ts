import type {
  AskCardState,
  AskCardView,
  ChatAdapter,
} from "../contract/chat.ts";
import type { AskAnswer, AskChoice } from "../contract/domain.ts";
import type { HubDb, SqlRow } from "../contract/runtime.ts";
import type { AskStore, StoreDeps } from "./store.ts";

function invalid(): never {
  throw new Error("Invalid hub ask row.");
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}

export function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : invalid();
}

export function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
): T {
  return options.find((option) => option === value) ?? invalid();
}

function array(json: unknown): readonly unknown[] {
  const parsed: unknown = JSON.parse(text(json));
  return Array.isArray(parsed) ? parsed : invalid();
}

export function choices(json: unknown): readonly AskChoice[] {
  return array(json).map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      !("label" in value)
    )
      return invalid();
    return { id: text(value.id), label: text(value.label) };
  });
}

export function allowed(row: SqlRow): readonly string[] {
  return array(row.allowed_json).map(text);
}

export function kind(row: SqlRow) {
  return oneOf(row.kind, ["choice", "work_request"] as const);
}

export function readAnswer(row: SqlRow): AskAnswer {
  const id = text(row.choice_id);
  const choice = choices(row.choices_json).find((option) => option.id === id);
  return {
    askId: text(row.ask_id),
    choiceId: id,
    choiceLabel: choice?.label ?? invalid(),
    answeredByPersonId: text(row.answered_by_person_id),
    answeredByName: text(row.display_name),
    answeredAt: integer(row.answered_at),
    source: oneOf(row.source, ["button", "digit"]),
  };
}

export function queueEdits(
  db: HubDb,
  at: number,
  askId: string | null = null,
): boolean {
  const queue = db.prepare(`
    INSERT INTO ask_edit_effects (ask_id, person_id, status, next_attempt_at, updated_at)
    SELECT d.ask_id, d.person_id, 'pending', ?, ? FROM ask_deliveries AS d
    JOIN asks AS a ON a.ask_id = d.ask_id
    WHERE d.delivery_state = 'delivered' AND d.edited_at IS NULL
      AND a.status IN ('answered','expired') AND (? IS NULL OR a.ask_id = ?)
    ON CONFLICT(ask_id, person_id) DO NOTHING
  `);
  return Number(queue.run(at, at, askId, askId).changes) > 0;
}

export function expire(
  db: HubDb,
  at: number,
  askId: string | null = null,
): number {
  const change = db.prepare(`
    UPDATE asks SET status = 'expired' WHERE status = 'open'
      AND (ask_id = ? OR (? IS NULL AND expires_at <= ?)) RETURNING ask_id
  `);
  const expired = change.all(askId, askId, at);
  for (const row of expired) queueEdits(db, at, text(row.ask_id));
  return expired.length;
}

type Effects = Omit<
  AskStore,
  "ask" | "answerAction" | "answerDigit" | "answerRows" | "findApprovedPermit"
>;

export function createAskEffects({
  db,
  now,
  adapter,
}: StoreDeps & { adapter: ChatAdapter }): Effects {
  const pending = db.prepare(`
    SELECT a.*, d.person_id, d.chat_thread_id, d.chat_message_id, d.channel_id, e.attempts,
      x.choice_id, x.answered_by_person_id, x.source, x.answered_at,
      p.display_name, q.name AS project_name, f.display_name AS asked_for_name, i.sender_name
    FROM ask_edit_effects AS e JOIN asks AS a ON a.ask_id = e.ask_id
    JOIN ask_deliveries AS d ON d.ask_id = e.ask_id AND d.person_id = e.person_id
    JOIN projects AS q ON q.project_id = a.project_id
    JOIN people AS f ON f.person_id = a.from_person_id
    LEFT JOIN inbox_items AS i ON i.item_id = a.inbox_item_id
    LEFT JOIN ask_answers AS x ON x.ask_id = a.ask_id
    LEFT JOIN people AS p ON p.person_id = x.answered_by_person_id
    WHERE e.status = 'pending' AND e.next_attempt_at <= ? AND d.delivery_state = 'delivered'
      AND d.adapter = ? AND a.status IN ('answered','expired')
    ORDER BY e.next_attempt_at, e.ask_id, e.person_id LIMIT ?
  `);
  const transition = db.prepare(`
    UPDATE ask_edit_effects SET status = ?, attempts = attempts + (? IS NOT NULL),
      next_attempt_at = coalesce(?, next_attempt_at), updated_at = ?
    WHERE ask_id = ? AND person_id = ? AND status = 'pending'
  `);
  const edited = db.prepare(`
    UPDATE ask_deliveries SET edited_at = ? WHERE ask_id = ? AND person_id = ? AND delivery_state = 'delivered'
  `);
  const interrupted = db.prepare(
    "UPDATE ask_deliveries SET delivery_state = 'unknown' WHERE delivery_state = 'posting'",
  );
  return {
    pendingEdits(limit) {
      return pending.all(now(), adapter, limit).map((row) => {
        const answer = row.status === "answered" ? readAnswer(row) : undefined;
        const state: AskCardState = answer
          ? {
              kind: "answered",
              answeredByName: answer.answeredByName,
              choiceLabel: answer.choiceLabel,
              answeredAt: new Date(answer.answeredAt).toISOString(),
            }
          : { kind: "expired" };
        const askId = text(row.ask_id);
        const type = kind(row);
        const card: AskCardView = {
          askId,
          kind: type,
          projectName: text(row.project_name),
          askedForName: text(row.asked_for_name),
          question: text(row.question),
          choices: choices(row.choices_json),
          state,
          ...(type !== "work_request"
            ? {}
            : row.inbox_item_id === null
              ? { issueId: text(row.issue_id) }
              : { requesterName: text(row.sender_name) }),
        };
        const ref = {
          chatThreadId: text(row.chat_thread_id),
          chatMessageId: text(row.chat_message_id),
          channelId: text(row.channel_id),
        };
        return {
          askId,
          personId: text(row.person_id),
          attempts: integer(row.attempts),
          ref,
          card,
        };
      });
    },
    markEditDone(askId, personId) {
      db.transaction(() => {
        const at = now();
        if (
          Number(
            transition.run("done", null, null, at, askId, personId).changes,
          )
        )
          edited.run(at, askId, personId);
      });
    },
    markEditFailed(askId, personId, nextAttemptAt) {
      transition.run(
        "pending",
        nextAttemptAt,
        nextAttemptAt,
        now(),
        askId,
        personId,
      );
    },
    sweepExpiry: () => db.transaction(() => expire(db, now())),
    reconcileEdits() {
      queueEdits(db, now());
    },
    markInterruptedPostingUnknown: () => Number(interrupted.run().changes),
  };
}
