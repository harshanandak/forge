import type { HubCore } from "../contract/core.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import type { EffectWorker } from "./effects.ts";
import { refused } from "./inbox.ts";
import { num } from "./thread.ts";

export function createReport(
  { chat, deps: { config, db, log, now }, store }: CoreContext,
  worker: EffectWorker,
): HubCore["report"] {
  const { asks, guards, sessions } = store;
  if (
    !chat ||
    !asks ||
    config.slack.mode === "off" ||
    (config.chat?.adapter ?? "slack") !== "slack"
  )
    return () => Promise.resolve(refused("BLOCK_DISABLED"));

  const putLine = db.prepare(`
    INSERT INTO summary_lines (project_id, person_id, issue_key, state, text, host_label, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, person_id, issue_key) DO UPDATE SET
      state = excluded.state, text = excluded.text, host_label = excluded.host_label,
      updated_at = excluded.updated_at
  `);
  const bump = db.prepare(`
    INSERT INTO summaries (project_id, publication_key, post_state, channel_id,
      chat_thread_id, chat_message_id, revision, updated_at)
    VALUES (?, ?, 'posted', ?, ?, ?, 1, ?)
    ON CONFLICT(project_id) DO UPDATE SET revision = summaries.revision + 1,
      updated_at = excluded.updated_at
    RETURNING revision
  `);
  const queue = db.prepare(`
    INSERT INTO summary_effects (project_id, target_revision, status, next_attempt_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET target_revision = excluded.target_revision,
      status = 'pending', updated_at = excluded.updated_at,
      attempts = CASE WHEN summary_effects.status = 'pending' THEN summary_effects.attempts ELSE 0 END,
      next_attempt_at = CASE WHEN summary_effects.status = 'pending' THEN summary_effects.next_attempt_at
        ELSE excluded.next_attempt_at END
  `);

  return async ({ person }, input) => {
    const { sessionId, projectId, issueId, requestAskId, state, text } = input;
    const recorded = store.tx(() => {
      const own = sessions.requireOwnSession(person, sessionId);
      if (!own.ok) return own;
      const { personId, host } = own.value;
      const modeError = sessions.requireNormalMode(own.value);
      if (modeError) return { ok: false, error: modeError } as const;
      const project = config.projects.find(
        (entry) => entry.projectId === projectId,
      );
      if (!project) return refused("PROJECT_UNKNOWN");
      if (!sessions.isMember(projectId, personId))
        return refused("NOT_PROJECT_MEMBER");
      if (!text.length || text.length > LIMITS.reportText)
        return refused("INPUT_INVALID", "/text");
      const textError = guards.outboundText(text, "/text");
      if (textError) return { ok: false, error: textError } as const;
      const permit = asks.findApprovedPermit(personId, projectId, requestAskId);
      if (
        !permit ||
        permit.scope.kind !== "request" ||
        (issueId !== undefined && issueId !== permit.scope.issueId)
      )
        return refused("PERMIT_REQUIRED");
      const ref = project.summaryMessage;
      if (!ref) return refused("CHAT_UNAVAILABLE");
      const at = now();
      putLine.run(
        projectId,
        personId,
        permit.scope.issueId ?? "",
        state,
        guards.storedText(text),
        host + " " + sessionId.slice(0, 8),
        at,
      );
      const row = bump.get(
        projectId,
        store.newId("summaryPublication"),
        ref.channelId,
        ref.chatThreadId,
        ref.chatMessageId,
        at,
      );
      const summaryRevision = num(row?.revision);
      queue.run(projectId, summaryRevision, at, at);
      return {
        ok: true,
        value: { permitId: permit.permitId, summaryRevision },
      } as const;
    });
    if (!recorded.ok) return recorded;

    void worker.drain().catch(() => log.warn("effect_drain_failed"));
    const summary = await worker
      .waitForSummary(projectId, recorded.value.summaryRevision)
      .catch(() => {
        log.warn("summary_wait_failed");
        return "queued" as const;
      });
    return { ok: true, value: { ...recorded.value, summary } };
  };
}
