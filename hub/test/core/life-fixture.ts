import type { HubDb, SqlValue } from "../../src/contract/runtime.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { createEffectWorker } from "../../src/core/effects.ts";
import { nullTracker } from "../../src/core/index.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { FakeHostBridge } from "../fakes/fake-host.ts";
import { doorbellFake, fakeHostCore } from "./base-fakes.ts";
import {
  a,
  caller,
  closeDb,
  configPeople,
  fixture,
  openDb,
  p1,
  seedHost,
  value,
} from "./fixture.ts";
import { button, choices, host, question } from "./fakes.ts";

export async function lifeFixture() {
  const f = await fixture({ hooks: { enabled: true } });
  const project = f.config.projects.find((entry) => entry.projectId === p1);
  if (!project?.summaryMessage)
    throw new Error("The fixture needs a configured summary");
  const ref = project.summaryMessage;
  const publicationKey = "fixture-summary";
  let time = 1_700_000_000_000;

  async function attach(db: HubDb) {
    const chat = new FakeChatPort(f.config.slack.teamId);
    const ctx = createCoreContext({
      config: f.config,
      db,
      chat,
      doorbell: doorbellFake(false).port,
      tracker: nullTracker,
      people: configPeople(f.config.people),
      log: f.log,
      now: () => time,
    });
    const core = createCoreBase(ctx);
    const worker = createEffectWorker(ctx);
    await chat.start(core.chatHandlers);
    chat.provisionSummary(ref.channelId, publicationKey, ref);

    async function answerChoice(to: readonly string[] = [a.personId]) {
      seedHost(db);
      const bridge = new FakeHostBridge(fakeHostCore(core), host);
      const { sessionId } = bridge.start("bound-effects", "startup");
      const { askId } = value(
        await core.ask(caller, {
          sessionId,
          projectId: p1,
          kind: "choice",
          requestedAction: "choice",
          to,
          question,
          choices,
        }),
      );
      const action = button(askId, "answer-" + askId);
      const delivery = db
        .prepare(
          "SELECT channel_id, chat_thread_id, chat_message_id FROM ask_deliveries WHERE ask_id = ? AND person_id = ?",
        )
        .get(askId, a.personId);
      const { channel_id, chat_thread_id, chat_message_id } = delivery ?? {};
      if (
        typeof channel_id !== "string" ||
        typeof chat_thread_id !== "string" ||
        typeof chat_message_id !== "string"
      )
        throw new Error("The fixture needs the delivered owner's DM");
      await chat.emitAction({
        ...action,
        message: {
          channelId: channel_id,
          chatThreadId: chat_thread_id,
          chatMessageId: chat_message_id,
        },
      });
      return askId;
    }

    function queueSummary() {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO summaries (project_id, publication_key, post_state, chat_thread_id, chat_message_id, channel_id, revision, updated_at) VALUES (?, ?, 'posted', ?, ?, ?, 1, ?)",
        ).run(
          p1,
          publicationKey,
          ref.chatThreadId,
          ref.chatMessageId,
          ref.channelId,
          time,
        );
        db.prepare(
          "INSERT INTO summary_effects (project_id, target_revision, status, next_attempt_at, updated_at) VALUES (?, 1, 'pending', ?, ?)",
        ).run(p1, time, time);
      });
    }

    return {
      chat,
      worker,
      answerChoice,
      queueSummary,
      rows: (sql: string, ...args: SqlValue[]) => db.prepare(sql).all(...args),
      now: () => time,
      advance: (ms: number) => {
        time += ms;
      },
      ref,
      publicationKey,
      async reopen() {
        await chat.stop();
        closeDb(db);
        return attach(openDb(f.path));
      },
      openPeer: () => openDb(f.path),
    };
  }

  return attach(f.db);
}
