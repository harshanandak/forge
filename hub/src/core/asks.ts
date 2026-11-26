import {
  ChatWriteFailure,
  type AskCardView,
  type ChatAdapter,
  type ChatMessageRef,
  type ChatPort,
} from "../contract/chat.ts";
import { WORK_REQUEST_CHOICES } from "../contract/domain.ts";
import type { HubErrorCode } from "../contract/errors.ts";
import { ISSUE_ID_PATTERN } from "../contract/ids.ts";
import { LIMITS } from "../contract/mcp.ts";
import { expire, queueEdits, text } from "./askEffects.ts";
import { newStoreId } from "./credentials.ts";
import { fail } from "./errors.ts";
import { validateAskAuthority } from "./guards.ts";
import type { AskStore, Guards, SessionStore, StoreDeps } from "./store.ts";

const invite =
  "The Forge app is not in that channel. Ask the owner to invite it.";
const permanent = {
  not_in_channel: invite,
  channel_not_found: invite,
  is_archived: "The channel is archived.",
  restricted_action: "Workspace rules forbid the Forge app from posting there.",
  canvas_unavailable: "The chat write is unavailable.",
};

function refuse(code: HubErrorCode, pointer?: string) {
  return { ok: false, error: fail(code, pointer) } as const;
}

export function createAsk(
  {
    db,
    config,
    people,
    chat,
    now,
    log,
    adapter,
  }: StoreDeps & { chat: ChatPort; adapter: ChatAdapter },
  sessions: SessionStore,
  guards: Guards,
): AskStore["ask"] {
  const source = db.prepare(`
    WITH RECURSIVE descendants(id, owner) AS (
      SELECT session_id, person_id FROM sessions WHERE session_id = ?
      UNION SELECT s.session_id, s.person_id FROM sessions AS s
        JOIN descendants AS d ON s.parent_session_id = d.id AND s.person_id = d.owner
    )
    SELECT sender_name FROM inbox_items AS i JOIN descendants AS d
      ON i.delivered_to_session_id = d.id AND i.owner_person_id = d.owner
    WHERE item_id = ? AND project_id = ? AND not_your_owner = 1
      AND kind IN ('chat_message','agent_message') AND delivered_at IS NOT NULL
  `);
  const put = db.prepare(`
    INSERT INTO asks (ask_id, project_id, kind, requested_action, from_session_id, from_person_id,
      from_session_untrusted_seq, question, choices_json, allowed_json, issue_id, inbox_item_id, status, created_at, expires_at)
    SELECT ?, ?, ?, ?, session_id, person_id, untrusted_read_seq, ?, ?, ?, ?, ?, 'open', ?, ?
    FROM sessions WHERE session_id = ?
  `);
  const planned = db.prepare(
    "INSERT INTO ask_deliveries (ask_id, person_id, adapter, delivery_state) VALUES (?, ?, ?, 'pending')",
  );
  const claim = db.prepare(`
    UPDATE ask_deliveries SET delivery_state = 'posting'
    WHERE ask_id = ? AND person_id = ? AND delivery_state = 'pending'
  `);
  const register = db.prepare(`
    UPDATE ask_deliveries SET delivery_state = ?, chat_thread_id = ?, chat_message_id = ?, channel_id = ?, delivered_at = ?
    WHERE ask_id = ? AND person_id = ? AND delivery_state IN ('posting','unknown')
  `);
  const readState = db.prepare(
    "SELECT delivery_state FROM ask_deliveries WHERE ask_id = ? AND person_id = ?",
  );

  return async (caller, input) => {
    const { projectId, kind, question, inboxItemId, issueId } = input;
    const work = kind === "work_request";
    const guard =
      validateAskAuthority(input) ?? guards.outboundText(question, "/question");
    if (guard) return { ok: false, error: guard };
    if (work && input.to !== undefined) return refuse("INPUT_INVALID", "/to");
    if (work && input.choices !== undefined)
      return refuse("INPUT_INVALID", "/choices");
    for (const [i, option] of (input.choices ?? []).entries()) {
      const error =
        guards.outboundText(option.label, `/choices/${i}/label`) ??
        guards.outboundText(option.id, `/choices/${i}/id`);
      if (error) return { ok: false, error };
    }
    if (issueId !== undefined) {
      const error = guards.outboundText(issueId, "/issueId");
      if (error) return { ok: false, error };
      if (!ISSUE_ID_PATTERN.test(issueId))
        return refuse("INPUT_INVALID", "/issueId");
    }
    const minutes = input.expiresInMinutes ?? LIMITS.askExpiryDefaultMinutes;
    if (
      !Number.isSafeInteger(minutes) ||
      minutes < 1 ||
      minutes > LIMITS.askExpiryMaxMinutes
    )
      return refuse("INPUT_INVALID", "/expiresInMinutes");

    const choices = work ? WORK_REQUEST_CHOICES : (input.choices ?? []);
    if (
      choices.length < LIMITS.choicesMin ||
      choices.length > LIMITS.choicesMax ||
      new Set(choices.map(({ id }) => id)).size !== choices.length
    )
      return refuse("INPUT_INVALID", "/choices");
    const ids = work ? [caller.person.personId] : [...new Set(input.to)];
    if (ids.length === 0 || ids.length > LIMITS.toMax)
      return refuse("INPUT_INVALID", "/to");

    const plan = db.transaction(() => {
      const owned = sessions.requireOwnSession(caller.person, input.sessionId);
      if (!owned.ok) return owned;
      const sessionId = owned.value.sessionId;
      const project = config.projects.find(
        (entry) => entry.projectId === projectId,
      );
      if (!project) return refuse("PROJECT_UNKNOWN");
      if (!sessions.isMember(projectId, owned.value.personId))
        return refuse("NOT_PROJECT_MEMBER");
      const mode = work ? undefined : sessions.requireNormalMode(owned.value);
      if (mode) return { ok: false, error: mode } as const;
      const recipients = [];
      for (const personId of ids) {
        const person = people.byPersonId(personId);
        if (!person) return refuse("PERSON_UNKNOWN");
        if (!sessions.isMember(projectId, personId))
          return refuse("NOT_PROJECT_MEMBER");
        const userId =
          adapter === "slack" ? person.slackUserId : person.telegramUserId;
        if (!userId)
          return {
            ok: false,
            error: { ...fail("CHAT_UNAVAILABLE"), retry: "never" },
          } as const;
        recipients.push({
          personId,
          name: person.displayName,
          userId,
        });
      }
      const item =
        work && inboxItemId !== undefined
          ? source.get(sessionId, inboxItemId, projectId)
          : undefined;
      if (work && (inboxItemId === undefined ? !issueId : !item))
        return refuse("WORK_REQUEST_SOURCE_INVALID");
      const at = now();
      const expiry = at + minutes * 60_000;
      const askId = newStoreId("ask");
      const state = {
        kind: "open" as const,
        digitFallback:
          !chat.capabilities.buttons ||
          (adapter === "slack" && !config.slack.buttons),
      };
      const card: AskCardView = {
        askId,
        kind,
        state,
        projectName: project.name,
        askedForName: caller.person.displayName,
        question: guards.storedText(question),
        choices,
        ...(item
          ? { requesterName: text(item.sender_name) }
          : work && issueId !== undefined
            ? { issueId }
            : {}),
      };
      put.run(
        askId,
        projectId,
        kind,
        input.requestedAction,
        card.question,
        JSON.stringify(choices),
        JSON.stringify(ids),
        issueId ?? null,
        work ? (inboxItemId ?? null) : null,
        at,
        expiry,
        sessionId,
      );
      for (const id of ids) planned.run(askId, id, adapter);
      return { ok: true, value: { card, recipients, expiry } } as const;
    });
    if (!plan.ok) return plan;

    const { card, recipients, expiry } = plan.value;
    const { askId } = card;
    let permanentMessage: string | undefined;
    let wait = 0;
    for (const { personId, userId } of recipients) {
      if (!Number(claim.run(askId, personId).changes)) continue;
      let ref: ChatMessageRef | undefined;
      let state = "unknown";
      try {
        ref = await chat.postAskDm(userId, card);
        state = "delivered";
      } catch (error) {
        if (error instanceof ChatWriteFailure && error.effect === "refused") {
          const delay = error.retryAfterMs ?? 0;
          if (Number.isSafeInteger(delay) && delay >= 0) {
            state = "refused";
            wait = Math.max(wait, delay);
            if (error.reason) permanentMessage ??= permanent[error.reason];
          }
        }
      }
      db.transaction(() => {
        const at = now();
        const { changes } = register.run(
          state,
          ref?.chatThreadId ?? null,
          ref?.chatMessageId ?? null,
          ref?.channelId ?? null,
          ref ? at : null,
          askId,
          personId,
        );
        if (ref && Number(changes)) queueEdits(db, at, askId);
      });
      if (!ref)
        log.warn("ask_delivery_unconfirmed", { askId, personId, state });
    }
    const deliveredTo = [];
    const pendingTo = [];
    for (const { personId, name } of recipients) {
      const state = readState.get(askId, personId)?.delivery_state;
      if (state === "delivered") deliveredTo.push({ personId, name });
      else if (state !== "refused") pendingTo.push({ personId, name });
    }
    if (!deliveredTo.length && !pendingTo.length) {
      db.transaction(() => expire(db, now(), askId));
      const error = fail("CHAT_UNAVAILABLE");
      const message = permanentMessage ?? error.message;
      const retry = permanentMessage ? "never" : "safe";
      const repair =
        wait && !permanentMessage
          ? `Wait ${Math.ceil(wait / 1000)} seconds before trying again.`
          : undefined;
      return {
        ok: false,
        error: { ...error, message, retry, ...(repair ? { repair } : {}) },
      };
    }
    const value = {
      askId,
      status: "open" as const,
      deliveredTo,
      pendingTo,
      expiresAt: new Date(expiry).toISOString(),
    };
    return { ok: true, value };
  };
}
