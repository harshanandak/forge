import type { HostCaller, HubResult } from "../contract/core.ts";
import type { InboxItem, Person, Sender, Session } from "../contract/domain.ts";
import type { HubErrorCode } from "../contract/errors.ts";
import type { HookModeInput } from "../contract/hooks.ts";
import { HUB_RULES, HUB_RULES_NO_SLACK, LIMITS } from "../contract/mcp.ts";
import type { HubStatement, SqlRow, SqlValue } from "../contract/runtime.ts";
import { unresolvedAgentPost } from "./agent-posts.ts";
import { newStoreId } from "./credentials.ts";
import { fail } from "./errors.ts";
import type { SessionStore, StoreDeps } from "./store.ts";

function invalidRow(): never {
  throw new Error("Invalid hub session or inbox row.");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : invalidRow();
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : invalidRow();
}

function oneOf<T extends string | number>(
  value: unknown,
  choices: readonly T[],
): T {
  return choices.find((choice) => choice === value) ?? invalidRow();
}

function optional<K extends string, T>(
  key: K,
  value: unknown,
  read: (value: unknown) => T,
): Partial<Record<K, T>> {
  return value === null ? {} : ({ [key]: read(value) } as Record<K, T>);
}

const hosts = ["claude", "codex", "opencode", "t3", "other"] as const;
const sources = ["startup", "resume", "clear", "compact"] as const;
const reasons = [
  "start",
  "unbound_start",
  "resume_unknown",
  "read_untrusted",
  "request_approved",
] as const;

function readSession(row: SqlRow): Session {
  return {
    sessionId: text(row.session_id),
    personId: text(row.person_id),
    host: oneOf(row.host, hosts),
    ...optional("hostInstanceId", row.host_instance_id, text),
    ...optional("hostSessionId", row.host_session_id, text),
    ...optional("startSource", row.start_source, (value) =>
      oneOf(value, sources),
    ),
    ...optional("threadId", row.thread_id, text),
    ...optional("parentSessionId", row.parent_session_id, text),
    ...optional("projectId", row.project_id, text),
    mode: oneOf(row.mode, ["normal", "reply_only"]),
    modeReason: oneOf(row.mode_reason, reasons),
    modeChangedAt: integer(row.mode_changed_at),
    untrustedReadSeq: integer(row.untrusted_read_seq),
    createdAt: integer(row.created_at),
    lastSeenAt: integer(row.last_seen_at),
  };
}

function readSender(row: SqlRow): Sender {
  const kind = oneOf(row.sender_kind, ["person", "agent", "cli", "system"]);
  if (kind === "system") return { kind };
  const person = {
    personId: text(row.sender_person_id),
    displayName: text(row.sender_name),
  };
  return kind === "person"
    ? { kind, ...person }
    : { kind, ...person, sessionId: text(row.sender_session_id) };
}

function readItem(row: SqlRow): InboxItem {
  return {
    itemId: text(row.item_id),
    dedupeKey: text(row.dedupe_key),
    ownerPersonId: text(row.owner_person_id),
    ...optional("targetSessionId", row.target_session_id, text),
    ...optional("forSubagentSessionId", row.for_subagent_session_id, text),
    ...optional("conversationId", row.conversation_id, text),
    ...optional("projectId", row.project_id, text),
    kind: oneOf(row.kind, [
      "chat_message",
      "agent_message",
      "cli_message",
      "system",
    ]),
    sender: readSender(row),
    notYourOwner: oneOf(row.not_your_owner, [0, 1]) === 1,
    held: oneOf(row.held, [0, 1]) === 1,
    text: text(row.text),
    ...optional("chatMessageId", row.chat_message_id, text),
    receivedAt: integer(row.received_at),
    ...optional("deliveredAt", row.delivered_at, integer),
    ...optional("deliveredToSessionId", row.delivered_to_session_id, text),
    ...optional("ackedAt", row.acked_at, integer),
  };
}

function ok<T>(value: T): HubResult<T> {
  return { ok: true, value };
}

function refusal(code: HubErrorCode, pointer?: string) {
  return { ok: false, error: fail(code, pointer) } as const;
}

type Deps = Pick<StoreDeps, "db" | "config" | "people" | "now">;

export function createSessionStore(deps: Deps): SessionStore {
  const { db, config, people, now } = deps;
  const byId = db.prepare("SELECT * FROM sessions WHERE session_id = ?");
  const bound = db.prepare(`
    SELECT * FROM sessions WHERE person_id = ? AND host_instance_id = ?
      AND host = ? AND host_session_id = ?
  `);
  const byThread = db.prepare(`
    SELECT * FROM sessions WHERE person_id = ? AND thread_id = ?
      AND host_instance_id IS NOT NULL ORDER BY last_seen_at DESC, session_id
  `);
  const member = db.prepare(`
    SELECT 1 FROM project_members WHERE project_id = ? AND person_id = ?
  `);
  const touch = db.prepare(`
    UPDATE sessions SET last_seen_at = ?, project_id = COALESCE(project_id, ?)
      WHERE session_id = ?
  `);
  const foreignItems = `owner_person_id = ? AND acked_at IS NULL AND project_id IS NOT ?
    AND (delivered_to_session_id = ? OR
      (delivered_to_session_id IS NULL AND target_session_id = ?))`;
  const attached = db.prepare(
    `SELECT 1 FROM inbox_items WHERE ${foreignItems} LIMIT 1`,
  );
  const owed = db.prepare(`
    SELECT 1 FROM reply_owed AS r JOIN conversations AS c USING (conversation_id)
    WHERE r.session_id = ? AND (? IS NULL OR c.project_id IS NOT ?) LIMIT 1
  `);
  const unresolved = unresolvedAgentPost(db);
  const replyWork = (sessionId: string, projectId: string | null) =>
    !!owed.get(sessionId, projectId, projectId) ||
    unresolved(sessionId, projectId);
  const recoverLegacy = db.prepare(`
    UPDATE inbox_items
    SET target_session_id = CASE WHEN target_session_id = ? THEN NULL ELSE target_session_id END,
      delivered_at = NULL, delivered_to_session_id = NULL
    WHERE ${foreignItems} AND (conversation_id IS NULL OR delivered_at IS NULL)
  `);
  const insertBound = db.prepare(`
    INSERT INTO sessions (session_id, person_id, host, host_instance_id, host_session_id, start_source,
      thread_id, mode, mode_reason, mode_changed_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `);
  const insertUnbound = db.prepare(`
    INSERT INTO sessions (session_id, person_id, host, parent_session_id, project_id,
      mode, mode_reason, mode_changed_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 'reply_only', 'unbound_start', ?, ?, ?) RETURNING *
  `);
  const taint = db.prepare(`
    WITH RECURSIVE chain(session_id, person_id, parent_session_id) AS (
      SELECT session_id, person_id, parent_session_id FROM sessions WHERE session_id = ?
      UNION
      SELECT p.session_id, p.person_id, p.parent_session_id FROM sessions AS p
      JOIN chain AS c ON p.session_id = c.parent_session_id AND p.person_id = c.person_id
    )
    UPDATE sessions SET mode = 'reply_only', mode_reason = 'read_untrusted', mode_changed_at = ?,
      untrusted_read_seq = untrusted_read_seq + 1 WHERE session_id IN (SELECT session_id FROM chain)
  `);
  const eligible = `FROM inbox_items AS i
    WHERE i.owner_person_id = ? AND i.held = 0 AND i.acked_at IS NULL
    AND i.project_id IS COALESCE(?, i.project_id)
    AND (i.project_id IS NULL OR EXISTS (
      SELECT 1 FROM project_members AS m WHERE m.project_id = i.project_id AND m.person_id = i.owner_person_id
    ))`;
  const order = "ORDER BY received_at, item_id LIMIT ?";
  const pending = `${eligible}
    AND i.delivered_at IS NULL AND (i.target_session_id IS NULL OR i.target_session_id = ?) ${order}`;
  const newItems = db.prepare("SELECT i.* " + pending);
  const sentItems = db.prepare(`SELECT i.* ${eligible}
    AND i.delivered_at IS NOT NULL AND i.delivered_to_session_id = ? ${order}`);
  const unreadItems = db.prepare(`SELECT item_id, count(*) OVER () AS unread,
    sum(not_your_owner) OVER () AS others ${pending}`);
  const hasPerson = (id: string) => people.byPersonId(id) !== undefined;
  const queryItems = (stmt: HubStatement, s: Session, limit: number) =>
    hasPerson(s.personId)
      ? stmt.all(s.personId, s.projectId ?? null, s.sessionId, limit)
      : [];

  const isMember = (projectId: string, personId: string) =>
    hasPerson(personId) && !!member.get(projectId, personId);

  function session(id: string): Session | undefined {
    const row = byId.get(id);
    if (!row || !hasPerson(text(row.person_id))) return undefined;
    return readSession(row);
  }

  function hookBinding(caller: HostCaller, input: HookModeInput) {
    const { person, hostInstanceId } = caller;
    const { host, hostSessionId } = input;
    if (!hasPerson(person.personId)) return undefined;
    const row = bound.get(person.personId, hostInstanceId, host, hostSessionId);
    return row ? readSession(row) : undefined;
  }

  function create(
    stmt: HubStatement,
    person: Person,
    host: Session["host"],
    fields: readonly SqlValue[],
  ) {
    if (!hasPerson(person.personId)) throw new Error("Unknown hub person.");
    const time = now();
    const args = [newStoreId("session"), person.personId, host, ...fields];
    const row = stmt.get(...args, time, time, time);
    return row ? readSession(row) : invalidRow();
  }

  function checkOwner(personId: string, id: string): HubResult<Session> {
    const found = session(id);
    if (!found) return refusal("SESSION_UNKNOWN");
    if (found.personId !== personId) return refusal("SESSION_NOT_YOURS");
    return ok(found);
  }

  function unreadCounts(s: Session) {
    const rows = queryItems(unreadItems, s, LIMITS.inboxDefault);
    const first = rows[0];
    return {
      unread: first ? integer(first.unread) : 0,
      unreadFromOthers: first ? integer(first.others) : 0,
      itemIds: rows.map((row) => text(row.item_id)),
    };
  }

  function projectList(personId: string) {
    return config.projects
      .filter((p) => isMember(p.projectId, personId))
      .map(({ projectId, name, purpose }) => ({
        projectId,
        name,
        ...(purpose === undefined ? {} : { purpose }),
      }));
  }

  return {
    hello({ person }, input) {
      return db.transaction(() => {
        const { personId } = person;
        const { sessionId, projectId, parentSessionId } = input;
        if (
          parentSessionId !== undefined &&
          (sessionId !== undefined ||
            session(parentSessionId)?.personId !== personId)
        )
          return refusal("INPUT_INVALID", "/parentSessionId");
        const existing =
          sessionId === undefined ? undefined : checkOwner(personId, sessionId);
        if (existing?.ok === false) return existing;
        const current = people.byPersonId(personId);
        if (!current) return refusal("UNAUTHENTICATED");
        if (projectId !== undefined) {
          if (!config.projects.some((p) => p.projectId === projectId))
            return refusal("PROJECT_UNKNOWN");
          if (!isMember(projectId, personId))
            return refusal("NOT_PROJECT_MEMBER");
        }
        const fields = [parentSessionId ?? null, projectId ?? null];
        const active =
          existing?.value ?? create(insertUnbound, current, input.host, fields);
        const id = active.sessionId;
        if (
          existing &&
          active.projectId === undefined &&
          projectId !== undefined &&
          (attached.get(personId, projectId, id, id) ||
            replyWork(id, projectId))
        )
          return {
            ok: false,
            error: {
              ...fail("INPUT_INVALID", "/projectId"),
              message:
                "This session has work from another project. Finish it in the original context or open a fresh session for the new project.",
            },
          };
        if (
          existing &&
          active.projectId !== undefined &&
          (projectId === undefined || projectId === active.projectId) &&
          attached.get(personId, active.projectId, id, id) &&
          !replyWork(id, null)
        )
          recoverLegacy.run(id, personId, active.projectId, id, id);
        if (existing) touch.run(now(), projectId ?? null, active.sessionId);
        const refreshed = session(active.sessionId) ?? active;
        const { unread, unreadFromOthers } = unreadCounts(refreshed);
        return ok({
          sessionId: active.sessionId,
          person: { personId, name: current.displayName },
          bound: active.hostInstanceId !== undefined,
          mode: active.mode,
          unread,
          unreadFromOthers,
          projects: projectList(personId),
          rules: config.slack.mode === "off" ? HUB_RULES_NO_SLACK : HUB_RULES,
        });
      });
    },
    hookSession(caller, input) {
      const { person, hostInstanceId } = caller;
      if (!hasPerson(person.personId)) return refusal("UNAUTHENTICATED");
      return db.transaction(() => {
        const { host, hostSessionId, source, threadId } = input;
        const clean = source === "startup" || source === "clear";
        const fields = [
          hostInstanceId,
          hostSessionId,
          source,
          threadId ?? null,
          clean ? "normal" : "reply_only",
          clean ? "start" : "resume_unknown",
        ];
        const active =
          hookBinding(caller, input) ??
          create(insertBound, person, host, fields);
        const { sessionId, mode } = active;
        return ok({ sessionId, mode, ...unreadCounts(active) });
      });
    },
    hookMode(caller, input) {
      const active = hookBinding(caller, input);
      if (!active) return ok({ mode: "unregistered" });
      const { mode, sessionId, modeChangedAt } = active;
      const since = new Date(modeChangedAt).toISOString();
      return ok({ mode, sessionId, since });
    },
    requireOwnSession(person, id) {
      const found = checkOwner(person.personId, id);
      if (!found.ok) return found;
      const lastSeenAt = now();
      touch.run(lastSeenAt, null, id);
      return ok({ ...found.value, lastSeenAt });
    },
    createUnboundSession: (person, projectId, host) =>
      create(insertUnbound, person, host, [null, projectId ?? null]),
    session,
    sessionsByThread: (personId, threadId) =>
      hasPerson(personId)
        ? byThread.all(personId, threadId).map(readSession)
        : [],
    markUntrustedRead: (id) => {
      if (session(id)) taint.run(id, now());
    },
    requireNormalMode: (s) =>
      s.mode === "normal" ? undefined : fail("REPLY_ONLY"),
    isMember,
    deliverable: (s, limit) => queryItems(newItems, s, limit).map(readItem),
    outstanding: (s, limit) => queryItems(sentItems, s, limit).map(readItem),
    unreadCounts,
  };
}
