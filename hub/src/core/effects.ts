import { ChatWriteFailure, type ChatMessageRef } from "../contract/chat.ts";
import type { Summary, SummaryLine } from "../contract/domain.ts";
import { LIMITS, type ReportOutput } from "../contract/mcp.ts";
import type { SqlRow } from "../contract/runtime.ts";
import { integer, oneOf, text } from "./askEffects.ts";
import type { CoreContext } from "./core.ts";

export interface EffectWorker {
  start(): Promise<void>;
  close(): Promise<void>;
  drain(): Promise<void>;
  waitForSummary(
    projectId: string,
    revision: number,
  ): Promise<ReportOutput["summary"]>;
}

export type EffectSchedule = (run: () => void, delayMs: number) => () => void;

function lifecycleNotBuilt(): Promise<void> {
  return Promise.reject(new Error("not_built"));
}

const backoffMs = [1_000, 5_000, 30_000, 120_000];

function summaryLine(row: SqlRow): SummaryLine {
  const issueId = text(row.issue_key);
  return {
    personId: text(row.person_id),
    personName: text(row.display_name),
    ...(issueId === "" ? {} : { issueId }),
    state: oneOf(row.state, ["working", "blocked", "done"]),
    text: text(row.text),
    hostLabel: text(row.host_label),
    updatedAt: integer(row.updated_at),
  };
}

type SummaryEdit = {
  summary: Summary;
  ref: ChatMessageRef;
  publicationKey: string;
  attempts: number;
};

type SummaryStatus = ReportOutput["summary"];

export function createEffectWorker(
  { chat, deps: { config, db, now }, store: { asks, tx } }: CoreContext,
  _schedule?: EffectSchedule,
): EffectWorker {
  if (!chat || !asks)
    return {
      start: lifecycleNotBuilt,
      close: lifecycleNotBuilt,
      drain: () => Promise.resolve(),
      waitForSummary: () => Promise.resolve("queued"),
    };
  const chatPort = chat;
  const askStore = asks;

  const configuredRefs = JSON.stringify(
    config.projects.flatMap(({ projectId, summaryMessage }) =>
      summaryMessage ? [{ projectId, ...summaryMessage }] : [],
    ),
  );
  const isSlack = (config.chat?.adapter ?? "slack") === "slack";
  const pendingSummary = db.prepare(`
    SELECT s.project_id, s.publication_key, s.channel_id, s.chat_thread_id,
      s.chat_message_id, s.revision, s.updated_at, p.name, e.attempts
    FROM summary_effects AS e
    JOIN summaries AS s USING (project_id)
    JOIN projects AS p USING (project_id)
    JOIN json_each(?) AS configured ON
      json_extract(configured.value, '$.projectId') = s.project_id
      AND json_extract(configured.value, '$.channelId') = s.channel_id
      AND json_extract(configured.value, '$.chatThreadId') = s.chat_thread_id
      AND json_extract(configured.value, '$.chatMessageId') = s.chat_message_id
    WHERE e.status = 'pending' AND e.next_attempt_at <= ? AND s.post_state = 'posted'
      AND e.target_revision <= s.revision
    ORDER BY e.next_attempt_at, s.project_id LIMIT 1
  `);
  const lines = db.prepare(`
    SELECT l.person_id, p.display_name, l.issue_key, l.state, l.text, l.host_label, l.updated_at
    FROM summary_lines AS l JOIN people AS p USING (person_id)
    WHERE l.project_id = ? ORDER BY l.person_id, l.issue_key
  `);
  const sameSummary = `
    project_id = ? AND publication_key = ? AND post_state = 'posted'
      AND channel_id = ? AND chat_thread_id = ? AND chat_message_id = ?
  `;
  const publish = db.prepare(`
    UPDATE summaries SET published_revision = max(published_revision, ?)
    WHERE ${sameSummary} RETURNING published_revision
  `);
  const summaryDone = db.prepare(`
    UPDATE summary_effects SET status = 'done', updated_at = ?
    WHERE project_id = ? AND status = 'pending' AND target_revision <= ?
  `);
  const summaryFailed = db.prepare(`
    UPDATE summary_effects SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
    WHERE status = 'pending' AND project_id = (
      SELECT project_id FROM summaries WHERE ${sameSummary}
    )
  `);
  const published = db.prepare(
    "SELECT published_revision FROM summaries WHERE project_id = ?",
  );
  const coolingDown = db.prepare(`
    SELECT 1 FROM meta WHERE key = 'chat_update_not_before' AND CAST(value AS INTEGER) > ?
  `);
  const extendCooldown = db.prepare(`
    INSERT INTO meta (key, value) VALUES ('chat_update_not_before', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)
  `);
  const summaryWaiters = new Set<
    (projectId: string, revision: number) => void
  >();

  function nextSummary(): SummaryEdit | undefined {
    if (!isSlack) return;
    return tx(() => {
      const row = pendingSummary.get(configuredRefs, now());
      if (!row) return;
      const projectId = text(row.project_id);
      return {
        summary: {
          projectId,
          projectName: text(row.name),
          revision: integer(row.revision),
          lines: lines.all(projectId).map(summaryLine),
          updatedAt: integer(row.updated_at),
        },
        ref: {
          channelId: text(row.channel_id),
          chatThreadId: text(row.chat_thread_id),
          chatMessageId: text(row.chat_message_id),
        },
        publicationKey: text(row.publication_key),
        attempts: integer(row.attempts),
      };
    });
  }

  function recordFailure(
    attempts: number,
    error: unknown,
    reschedule: (deadline: number, at: number) => void,
  ): void {
    const at = now();
    const retryAfter =
      error instanceof ChatWriteFailure && error.effect === "refused"
        ? error.retryAfterMs
        : undefined;
    const retryAfterMs =
      retryAfter !== undefined &&
      Number.isSafeInteger(retryAfter) &&
      retryAfter >= 0
        ? retryAfter
        : undefined;
    const delay = Math.max(backoffMs[attempts] ?? 600_000, retryAfterMs ?? 0);
    tx(() => {
      if (isSlack && retryAfterMs !== undefined)
        extendCooldown.run(String(at + retryAfterMs));
      reschedule(at + delay, at);
    });
  }

  async function attempt(
    attempts: number,
    write: () => Promise<void | "edited" | "missing">,
    complete: () => void,
    reschedule: (deadline: number, at: number) => void,
  ): Promise<boolean> {
    if (isSlack && coolingDown.get(now())) return false;
    let result: void | "edited" | "missing";
    try {
      result = await write();
    } catch (error) {
      recordFailure(attempts, error, reschedule);
      return true;
    }
    if (result === "missing") recordFailure(attempts, undefined, reschedule);
    else complete();
    return true;
  }

  async function drainDue(): Promise<void> {
    for (;;) {
      const [ask] = askStore.pendingEdits(1);
      if (ask) {
        const sent = await attempt(
          ask.attempts,
          () => chatPort.editAskDm(ask.ref, ask.card),
          () => askStore.markEditDone(ask.askId, ask.personId),
          (deadline) =>
            askStore.markEditFailed(ask.askId, ask.personId, deadline),
        );
        if (!sent) return;
      }

      const job = nextSummary();
      if (!job) {
        if (!ask) return;
        continue;
      }
      const { ref, summary, publicationKey } = job;
      const { projectId, revision } = summary;
      const identity = [
        projectId,
        publicationKey,
        ref.channelId,
        ref.chatThreadId,
        ref.chatMessageId,
      ];
      const sent = await attempt(
        job.attempts,
        () => chatPort.editSummary(ref, summary),
        () => {
          const publishedRevision = tx(() => {
            const row = publish.get(revision, ...identity);
            if (!row) return;
            summaryDone.run(now(), projectId, revision);
            return integer(row.published_revision);
          });
          if (publishedRevision !== undefined)
            for (const wake of summaryWaiters)
              wake(projectId, publishedRevision);
        },
        (deadline, at) => summaryFailed.run(deadline, at, ...identity),
      );
      if (!sent) return;
    }
  }

  let draining: Promise<void> | undefined;
  let drainRequested = false;

  async function drainRequestedWork(): Promise<void> {
    try {
      do {
        drainRequested = false;
        await drainDue();
      } while (drainRequested);
    } finally {
      draining = undefined;
    }
  }

  return {
    start: lifecycleNotBuilt,
    close: lifecycleNotBuilt,
    drain() {
      drainRequested = true;
      draining ??= Promise.resolve().then(drainRequestedWork);
      return draining;
    },
    async waitForSummary(projectId, revision) {
      const row = published.get(projectId);
      if (row && integer(row.published_revision) >= revision) return "edited";
      return new Promise<SummaryStatus>((resolve) => {
        function wake(updatedProject: string, updatedRevision: number): void {
          if (updatedProject === projectId && updatedRevision >= revision)
            finish("edited");
        }
        function finish(status: SummaryStatus): void {
          clearTimeout(timer);
          summaryWaiters.delete(wake);
          resolve(status);
        }
        const timer = setTimeout(() => finish("queued"), LIMITS.reportWaitMs);
        summaryWaiters.add(wake);
      });
    },
  };
}
