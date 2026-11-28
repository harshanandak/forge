import {
  ChatWriteFailure,
  type ChatMessageRef,
  type ChatWriteDeadline,
} from "../contract/chat.ts";
import type { Summary, SummaryLine } from "../contract/domain.ts";
import { LIMITS, type ReportOutput } from "../contract/mcp.ts";
import type { SqlRow, WorkerClaim } from "../contract/runtime.ts";
import { AGENT_POST_JOURNAL_PREFIX } from "./agent-posts.ts";
import { createAskEditCompletion, integer, oneOf, text } from "./askEffects.ts";
import type { CoreContext } from "./core.ts";
import { readStoredDisplayName } from "./directory.ts";
import { keepLoopGuardRows } from "./thread.ts";

export interface EffectWorker {
  prepare(): void;
  start(): Promise<void>;
  close(): Promise<void>;
  drain(): Promise<void>;
  waitForSummary(
    projectId: string,
    revision: number,
  ): Promise<ReportOutput["summary"]>;
}

export type EffectSchedule = (run: () => void, delayMs: number) => () => void;

function scheduleTimer(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

const sweepMs = 60_000;
const closeMs = 5_000;
const dayMs = 86_400_000;
const backoffMs = [1_000, 5_000, 30_000, 120_000];

function summaryLine(row: SqlRow): SummaryLine {
  const issueId = text(row.issue_key);
  return {
    personId: text(row.person_id),
    personName: readStoredDisplayName(row.display_name),
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

type SummaryWaiter = {
  wake(projectId: string, revision: number): void;
  refuse(): void;
};

export function createEffectWorker(
  { chat, deps: { config, db, log, now }, store: { asks, tx } }: CoreContext,
  schedule: EffectSchedule = scheduleTimer,
): EffectWorker {
  if (!chat || !asks) {
    let claim: WorkerClaim | undefined;
    return {
      prepare: () => void (claim ??= db.claimWorker()),
      start: () => Promise.resolve(),
      close: () => Promise.resolve().then(() => claim?.release()),
      drain: () => Promise.resolve(),
      waitForSummary: () => Promise.resolve("queued"),
    };
  }
  const chatPort = chat;
  const askStore = asks;
  const askEditCompletion = createAskEditCompletion(db, now);

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
  const rebindSummary = db.prepare(`
    UPDATE summaries SET channel_id = ?, chat_thread_id = ?, chat_message_id = ?,
      post_state = 'posted', published_revision = 0
    WHERE project_id = ? AND (
      channel_id IS NOT ? OR chat_thread_id IS NOT ? OR chat_message_id IS NOT ?
      OR post_state <> 'posted'
    )
  `);
  const recoverSummary = db.prepare(`
    INSERT INTO summary_effects (project_id, target_revision, status, next_attempt_at, updated_at)
    SELECT project_id, revision, 'pending', ?, ? FROM summaries
    WHERE project_id = ? AND (published_revision < revision OR ?)
    ON CONFLICT(project_id) DO UPDATE SET target_revision = excluded.target_revision,
      status = 'pending', updated_at = excluded.updated_at,
      attempts = CASE WHEN summary_effects.status = 'pending' THEN summary_effects.attempts ELSE 0 END,
      next_attempt_at = CASE WHEN summary_effects.status = 'pending' THEN summary_effects.next_attempt_at
        ELSE excluded.next_attempt_at END
  `);
  const threadsNeedingRetention = db.prepare(`
    SELECT chat_thread_id,
      EXISTS(SELECT 1 FROM meta WHERE key = ? || chat_thread_id) AS pending_post
    FROM thread_messages WHERE adapter = 'slack'
    GROUP BY chat_thread_id HAVING min(created_at) < ? OR count(*) > ?
  `);
  const pruneThreadMessages = db.prepare(`
    WITH protected AS (SELECT value FROM json_each(?)),
    ranked AS (
      SELECT seq, row_number() OVER (
        PARTITION BY adapter, chat_thread_id
        ORDER BY (seq IN protected) DESC, seq DESC
      ) AS position
      FROM thread_messages WHERE created_at >= ? OR seq IN protected
    )
    DELETE FROM thread_messages
      WHERE (created_at < ? AND seq NOT IN protected)
        OR seq IN (SELECT seq FROM ranked WHERE position > ?)
  `);
  const pruneReplyOwed = db.prepare(
    "DELETE FROM reply_owed WHERE created_at < ?",
  );
  const summaryWaiters = new Set<SummaryWaiter>();
  let draining: Promise<void> | undefined;
  let drainRequested = false;
  let starting: Promise<void> | undefined;
  let started = false;
  let stopped = false;
  let abandoned = false;
  let closeDeadline: number | undefined;
  let closing: Promise<void> | undefined;
  let cancelSweep: (() => void) | undefined;
  let ownership: WorkerClaim | undefined;
  const writeDeadline: ChatWriteDeadline = {
    expiresAt: () => closeDeadline,
    now,
  };

  function prepare(): void {
    if (stopped) return;
    ownership ??= db.claimWorker();
  }

  function releaseOwnership(): void {
    const claim = ownership;
    claim?.release();
    ownership = undefined;
  }

  function writeAbandoned(): boolean {
    return abandoned || (closeDeadline !== undefined && now() >= closeDeadline);
  }

  function refuseSummaryWaiters(): void {
    for (const waiter of summaryWaiters) waiter.refuse();
  }

  function cancelScheduled(cancel: () => void): void {
    try {
      cancel();
    } catch {
      log.warn("effect_schedule_cancel_failed");
    }
  }

  function retainHistory(): void {
    const cutoff = now() - LIMITS.threadKeepDays * dayMs;
    tx(() => {
      const keep = new Set<number>();
      for (const row of threadsNeedingRetention.all(
        AGENT_POST_JOURNAL_PREFIX,
        cutoff,
        LIMITS.threadKeep,
      ))
        keepLoopGuardRows(db, text(row.chat_thread_id), {
          cutoff,
          keep,
          pendingPost: integer(row.pending_post) === 1,
        });
      pruneThreadMessages.run(
        JSON.stringify([...keep]),
        cutoff,
        cutoff,
        LIMITS.threadKeep,
      );
      pruneReplyOwed.run(cutoff);
    });
  }

  function sweep(): void {
    askStore.sweepExpiry();
    retainHistory();
  }

  function reconcile(): void {
    tx(() => {
      const at = now();
      for (const { projectId, summaryMessage: ref } of config.projects) {
        if (!ref) continue;
        const fields = [ref.channelId, ref.chatThreadId, ref.chatMessageId];
        const change = rebindSummary.run(...fields, projectId, ...fields);
        recoverSummary.run(
          at,
          at,
          projectId,
          Number(change.changes) > 0 ? 1 : 0,
        );
      }
      askStore.markInterruptedPostingUnknown();
      askStore.reconcileEdits();
    });
    sweep();
  }

  function nextSummary(): SummaryEdit | undefined {
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
  ): boolean {
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
    return tx(() => {
      if (writeAbandoned()) return false;
      if (isSlack && retryAfterMs !== undefined)
        extendCooldown.run(String(at + retryAfterMs));
      reschedule(at + delay, at);
      return true;
    });
  }

  async function attempt(
    attempts: number,
    write: () => Promise<void | "edited" | "missing" | "abandoned">,
    complete: () => boolean | void,
    reschedule: (deadline: number, at: number) => void,
  ): Promise<boolean> {
    if (stopped || starting || (isSlack && coolingDown.get(now())))
      return false;
    let result: void | "edited" | "missing" | "abandoned";
    try {
      result = await write();
    } catch (error) {
      if (writeAbandoned()) return false;
      return recordFailure(attempts, error, reschedule);
    }
    if (writeAbandoned() || result === "abandoned") return false;
    if (result === "missing")
      return recordFailure(attempts, undefined, reschedule);
    return complete() !== false;
  }

  async function drainDue(): Promise<void> {
    while (!stopped && !starting) {
      const [ask] = askStore.pendingEdits(1);
      if (ask) {
        const sent = await attempt(
          ask.attempts,
          () => chatPort.editAskDm(ask.ref, ask.card),
          () =>
            tx(() => {
              if (writeAbandoned()) return false;
              askEditCompletion.done(ask.askId, ask.personId);
              return true;
            }),
          (deadline) =>
            askStore.markEditFailed(ask.askId, ask.personId, deadline),
        );
        if (!sent || stopped || starting) return;
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
        () => chatPort.editSummary(ref, summary, writeDeadline),
        () => {
          let expired = false;
          const publishedRevision = tx(() => {
            if (writeAbandoned()) {
              expired = true;
              return;
            }
            const row = publish.get(revision, ...identity);
            if (!row) return;
            summaryDone.run(now(), projectId, revision);
            return integer(row.published_revision);
          });
          if (expired) return false;
          if (publishedRevision !== undefined)
            for (const waiter of summaryWaiters)
              waiter.wake(projectId, publishedRevision);
        },
        (deadline, at) => summaryFailed.run(deadline, at, ...identity),
      );
      if (!sent) return;
    }
  }

  async function drainRequestedWork(): Promise<void> {
    try {
      if (stopped) return;
      prepare();
      do {
        drainRequested = false;
        await drainDue();
      } while (drainRequested && !stopped && !starting);
    } catch (error) {
      refuseSummaryWaiters();
      throw error;
    } finally {
      draining = undefined;
    }
  }

  function drain(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (starting) return starting.then(drain);
    drainRequested = true;
    draining ??= Promise.resolve().then(drainRequestedWork);
    return draining;
  }

  function kick(): void {
    void drain().catch(() => log.warn("effect_drain_failed"));
  }

  function scheduleSweep(): void {
    cancelSweep = schedule(() => {
      if (stopped) return;
      try {
        sweep();
        kick();
      } catch {
        log.warn("effect_sweep_failed");
      }
      scheduleSweep();
    }, sweepMs);
  }

  function start(): Promise<void> {
    if (stopped || started) return Promise.resolve();
    let claimedByStart = false;
    starting ??= Promise.resolve(draining)
      .then(() => {
        if (stopped) return;
        const hadOwnership = ownership !== undefined;
        prepare();
        claimedByStart = !hadOwnership;
        reconcile();
        scheduleSweep();
        started = true;
      })
      .catch((error: unknown) => {
        refuseSummaryWaiters();
        if (claimedByStart) releaseOwnership();
        throw error;
      })
      .finally(() => {
        starting = undefined;
      });
    return starting.then(kick);
  }

  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    if (cancelSweep) cancelScheduled(cancelSweep);
    cancelSweep = undefined;
    const active = draining;
    const release = () => releaseOwnership();
    if (!active) {
      closing = Promise.resolve().then(release);
      return closing;
    }
    closing = new Promise<void>((resolve, reject) => {
      closeDeadline = now() + closeMs;
      const cancelLimit = schedule(() => {
        abandoned = true;
        resolve();
      }, closeMs);
      const finish = () => {
        cancelScheduled(cancelLimit);
        try {
          release();
          resolve();
        } catch (error) {
          if (abandoned) log.warn("effect_worker_lock_release_failed");
          else
            reject(
              error instanceof Error
                ? error
                : new Error("Hub effect worker lock release failed"),
            );
        }
      };
      void active.then(finish, finish);
    });
    return closing;
  }

  return {
    prepare,
    start,
    close,
    drain,
    async waitForSummary(projectId, revision) {
      if (stopped) return "queued";
      const row = published.get(projectId);
      if (row && integer(row.published_revision) >= revision) return "edited";
      return new Promise<SummaryStatus>((resolve) => {
        function wake(updatedProject: string, updatedRevision: number): void {
          if (updatedProject === projectId && updatedRevision >= revision)
            finish("edited");
        }
        function refuse(): void {
          finish("queued");
        }
        function finish(status: SummaryStatus): void {
          clearTimeout(timer);
          summaryWaiters.delete(waiter);
          resolve(status);
        }
        const waiter = { wake, refuse };
        const timer = setTimeout(() => finish("queued"), LIMITS.reportWaitMs);
        summaryWaiters.add(waiter);
      });
    },
  };
}
