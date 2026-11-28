import {
  ASK_ACTION_PREFIX,
  type ChatAdapter,
  type ChatMessageEvent,
} from "../contract/chat.ts";
import type { AnswerOutcome } from "../contract/domain.ts";
import {
  allowed,
  choices,
  expire,
  integer,
  kind,
  oneOf,
  queueEdits,
  readAnswer,
  text,
} from "./askEffects.ts";
import { newStoreId } from "./credentials.ts";
import { isTelegramId, readStoredDisplayName } from "./directory.ts";
import type {
  AnswerAfter,
  AskStore,
  SessionStore,
  StoreDeps,
} from "./store.ts";

const instruction = "Reply under the ask's card, or send <askId> <number>.";
const refusals = {
  expired: "This ask has expired.",
  invalid_choice: "That choice is not on this ask.",
  unknown_ask: "This ask no longer exists.",
  unknown_answerer: "You are not set up in Forge for this workspace.",
};
const outcomes = [
  "locked",
  "already_answered",
  "not_allowed",
  "expired",
  "invalid_choice",
  "unknown_ask",
  "unknown_answerer",
] as const;
type Answers = Pick<
  AskStore,
  "answerAction" | "answerDigit" | "answerRows" | "findApprovedPermit"
>;

export function createAnswers(
  { db, people, now, adapter }: StoreDeps & { adapter: ChatAdapter },
  sessions: SessionStore,
): Answers {
  const ask = db.prepare(`
    SELECT a.*, x.ask_id AS answered FROM asks AS a LEFT JOIN ask_answers AS x ON x.ask_id = a.ask_id WHERE a.ask_id = ?
      AND EXISTS (SELECT 1 FROM ask_deliveries d WHERE d.ask_id = a.ask_id AND d.adapter = ?)
  `);
  const winner = db.prepare(`
    SELECT x.*, a.choices_json, p.display_name FROM ask_answers AS x
    JOIN asks AS a ON a.ask_id = x.ask_id
    JOIN people AS p ON p.person_id = x.answered_by_person_id WHERE x.ask_id = ?
  `);
  const post = db.prepare(`
    INSERT INTO ask_answers (ask_id, choice_id, answered_by_person_id, answered_at, source, event_key)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ask_id) DO NOTHING
  `);
  const retry = db.prepare(
    "SELECT ask_id, outcome, slack_user_id FROM answer_attempts WHERE adapter = ? AND event_key = ?",
  );
  const record = db.prepare(`
    INSERT INTO answer_attempts (adapter, event_key, ask_id, slack_user_id, choice_id, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const byThread = db.prepare(`
    SELECT ask_id FROM ask_deliveries WHERE adapter = ? AND person_id = ? AND channel_id = ?
      AND chat_message_id = ? AND delivery_state = 'delivered' LIMIT 2
  `);
  const byId = db.prepare(`
    SELECT ask_id FROM ask_deliveries WHERE adapter = ? AND person_id = ? AND ask_id = ?
      AND delivery_state IN ('posting','unknown','delivered')
  `);
  const permit = db.prepare(`
    INSERT INTO permits (permit_id, person_id, project_id, scope_key, issue_id, request_ask_id, source, evidence, created_at)
    SELECT ?, from_person_id, project_id, 'request:' || ask_id, issue_id, ask_id, 'approved_request', 'owner_approval', ?
    FROM asks WHERE ask_id = ?
  `);
  const restore = db.prepare(`
    UPDATE sessions AS s SET mode = 'normal', mode_reason = 'request_approved', mode_changed_at = ?
    FROM asks AS a WHERE a.ask_id = ? AND s.session_id = a.from_session_id AND s.person_id = a.from_person_id
      AND s.mode = 'reply_only' AND s.untrusted_read_seq = a.from_session_untrusted_seq
  `);
  const finish = db.prepare(
    "UPDATE asks SET status = 'answered' WHERE ask_id = ?",
  );
  const names = db.prepare(`
    SELECT p.display_name FROM asks AS a JOIN json_each(a.allowed_json) AS j
    JOIN people AS p ON p.person_id = j.value WHERE a.ask_id = ? ORDER BY j.key
  `);
  const readRows = db.prepare(`
    SELECT x.*, a.kind, a.choices_json, p.display_name, m.permit_id FROM ask_answers AS x
    JOIN asks AS a ON a.ask_id = x.ask_id
    JOIN project_members AS member ON member.project_id = a.project_id AND member.person_id = a.from_person_id
    JOIN people AS p ON p.person_id = x.answered_by_person_id
    LEFT JOIN permits AS m ON m.request_ask_id = a.ask_id AND m.person_id = a.from_person_id
      AND m.project_id = a.project_id AND m.scope_key = 'request:' || a.ask_id
      AND m.source = 'approved_request' AND m.revoked_at IS NULL
    WHERE a.from_session_id = ? AND x.acked_at IS NULL ORDER BY x.answered_at, x.ask_id LIMIT ?
  `);
  const active = db.prepare(`
    SELECT permit_id, issue_id, created_at FROM permits WHERE person_id = ? AND project_id = ?
      AND request_ask_id = ? AND scope_key = 'request:' || request_ask_id AND source = 'approved_request'
      AND evidence = 'owner_approval' AND revoked_at IS NULL
  `);

  function describe(verdict: AnswerOutcome["kind"], id: string) {
    if (verdict === "locked" || verdict === "already_answered") {
      const row = winner.get(id);
      if (!row) throw new Error("Missing locked hub answer.");
      const answer = readAnswer(row);
      const time = new Date(answer.answeredAt).toISOString().slice(11, 16);
      const message = `Already answered by ${answer.answeredByName} at ${time} UTC: ${answer.choiceLabel}.`;
      return {
        outcome: { kind: verdict, answer },
        reply: verdict === "locked" ? {} : { ephemeralText: message },
      };
    }
    const intended =
      verdict === "not_allowed"
        ? names.all(id).map((row) => readStoredDisplayName(row.display_name))
        : [];
    const ephemeralText =
      verdict === "not_allowed"
        ? `This ask is for ${intended.join(", ")}.`
        : refusals[verdict];
    return { outcome: { kind: verdict }, reply: { ephemeralText } };
  }

  function userId(identity: unknown, legacyId: unknown): string | undefined {
    if (identity === undefined)
      return adapter === "slack" && typeof legacyId === "string"
        ? legacyId
        : undefined;
    if (
      typeof identity !== "object" ||
      identity === null ||
      !("adapter" in identity) ||
      identity.adapter !== adapter ||
      !("userId" in identity)
    )
      return;
    const id = identity.userId;
    if (adapter === "telegram") return isTelegramId(id) ? id : undefined;
    return typeof id === "string" ? id : undefined;
  }

  function answer(
    eventKey: string,
    chatUserId: string,
    selection: string | number,
    explicit?: string,
    ref?: Pick<ChatMessageEvent, "channelId" | "threadRootMessageId"> & {
      tap?: true;
    },
  ) {
    return db.transaction(() => {
      const prior = retry.get(adapter, eventKey);
      if (prior && prior.slack_user_id !== chatUserId) return;
      const person = people.byChatUserId(adapter, chatUserId);
      let id = prior ? text(prior.ask_id) : explicit;
      if (ref && (!prior || ref.tap)) {
        if (!person) return;
        const refs = explicit
          ? byId.all(adapter, person.personId, explicit)
          : byThread.all(
              adapter,
              person.personId,
              ref.channelId,
              ref.threadRootMessageId ?? null,
            );
        if (refs.length !== 1 || !refs[0]) return;
        id = text(refs[0].ask_id);
        if (prior && prior.ask_id !== id) return;
      }
      if (id === undefined) return;
      const row = ask.get(id, adapter);
      const actor = person?.personId;
      const eligible =
        row &&
        actor !== undefined &&
        allowed(row).includes(actor) &&
        sessions.isMember(text(row.project_id), actor) &&
        (kind(row) === "choice" || row.from_person_id === actor);
      const at = now();
      let verdict: AnswerOutcome["kind"];
      let after: AnswerAfter | undefined;
      let choiceId = String(selection);
      if (!row) verdict = "unknown_ask";
      else if (!person)
        verdict = prior ? oneOf(prior.outcome, outcomes) : "unknown_answerer";
      else if (!eligible && (prior || row.answered !== null))
        verdict = "not_allowed";
      else if (prior) verdict = oneOf(prior.outcome, outcomes);
      else if (row.answered !== null) verdict = "already_answered";
      else if (row.status === "expired" || integer(row.expires_at) <= at) {
        expire(db, at, id);
        verdict = "expired";
      } else if (!eligible) verdict = "not_allowed";
      else {
        const projectId = text(row.project_id);
        const fromPersonId = text(row.from_person_id);
        const work = kind(row) === "work_request";
        const actor = person.personId;
        const options = choices(row.choices_json);
        const digit = typeof selection === "number";
        const choice = digit
          ? options[selection - (ref?.tap ? 0 : 1)]
          : options.find((option) => option.id === selection);
        if (!choice) verdict = "invalid_choice";
        else {
          choiceId = choice.id;
          const { changes } = post.run(
            id,
            choiceId,
            actor,
            at,
            digit && !ref?.tap ? "digit" : "button",
            eventKey,
          );
          verdict = Number(changes) ? "locked" : "already_answered";
          if (verdict === "locked") {
            finish.run(id);
            if (work && choiceId === "approve") {
              permit.run(newStoreId("permit"), at, id);
              restore.run(at, id);
            }
            const fromSessionId = text(row.from_session_id);
            after = {
              askId: id,
              projectId,
              fromSessionId,
              fromPersonId,
              queuedEdits: queueEdits(db, at, id),
            };
          }
        }
      }
      if (!prior)
        record.run(adapter, eventKey, id, chatUserId, choiceId, verdict, at);
      return { ...describe(verdict, id), after };
    });
  }

  return {
    answerAction(event) {
      const { actionId, eventKey, chatIdentity, slackUserId, value } = event;
      if (!actionId.startsWith(ASK_ACTION_PREFIX)) return { reply: {} };
      const id = userId(chatIdentity, slackUserId);
      const tap = adapter === "telegram" && actionId === ASK_ACTION_PREFIX;
      const refuse = (ephemeralText: string) => ({
        reply: tap ? { ephemeralText } : {},
      });
      if (id === undefined) return refuse(refusals.unknown_answerer);
      if (tap && !/^[0-9]$/.test(value)) return refuse(refusals.invalid_choice);
      const result = answer(
        eventKey,
        id,
        tap ? Number(value) : actionId.slice(ASK_ACTION_PREFIX.length),
        tap ? undefined : value,
        tap
          ? {
              channelId: event.message.channelId,
              threadRootMessageId: event.message.chatMessageId,
              tap: true,
            }
          : undefined,
      );
      if (!result) return refuse(refusals.unknown_ask);
      return result.after
        ? { reply: result.reply, after: result.after }
        : { reply: result.reply };
    },
    answerDigit(event) {
      const match = /^(?:(ask_[A-Za-z0-9_-]{1,64})[ \t]+)?([0-9])$/.exec(
        event.text.trim(),
      );
      if (!match || !event.isDirect || event.isBot)
        return { kind: "not_a_digit_reply" };
      const id = userId(event.chatIdentity, event.slackUserId);
      if (id === undefined) return { kind: "instruction", text: instruction };
      const result = answer(
        event.eventKey,
        id,
        Number(match[2]),
        match[1],
        event,
      );
      if (!result) return { kind: "instruction", text: instruction };
      return {
        kind: "answered",
        outcome: result.outcome,
        ...result.reply,
        ...(result.after ? { after: result.after } : {}),
      };
    },
    answerRows(sessionId, limit) {
      if (!sessions.session(sessionId)) return [];
      return readRows.all(sessionId, limit).map((row) => {
        const {
          askId,
          choiceId,
          choiceLabel,
          answeredByPersonId,
          answeredByName,
          answeredAt,
        } = readAnswer(row);
        const delivered = row.delivered_at !== null;
        const answeredBy = {
          personId: answeredByPersonId,
          name: answeredByName,
        };
        return {
          delivered,
          acked: false,
          view: {
            askId,
            kind: kind(row),
            choiceId,
            choiceLabel,
            answeredBy,
            answeredAt: new Date(answeredAt).toISOString(),
            redelivered: delivered,
            ...(row.permit_id === null
              ? {}
              : { permitId: text(row.permit_id) }),
          },
        };
      });
    },
    findApprovedPermit(personId, projectId, requestAskId) {
      if (!sessions.isMember(projectId, personId)) return;
      const row = active.get(personId, projectId, requestAskId);
      if (!row) return;
      const scope = {
        kind: "request" as const,
        askId: requestAskId,
        ...(row.issue_id === null ? {} : { issueId: text(row.issue_id) }),
      };
      return {
        permitId: text(row.permit_id),
        personId,
        projectId,
        scope,
        createdAt: integer(row.created_at),
        source: "approved_request",
        evidence: "owner_approval",
      };
    },
  };
}
