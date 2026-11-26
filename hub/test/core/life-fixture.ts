import type { Caller } from "../../src/contract/core.ts";
import type { Person } from "../../src/contract/domain.ts";
import type { HubDb, SqlValue } from "../../src/contract/runtime.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { createEffectWorker } from "../../src/core/effects.ts";
import { nullTracker } from "../../src/core/index.ts";
import { createReport } from "../../src/core/report.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { FakeHostBridge } from "../fakes/fake-host.ts";
import { doorbellFake, fakeHostCore } from "./base-fakes.ts";
import {
  a,
  b,
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

  function context(db: HubDb, chat: FakeChatPort) {
    return createCoreContext({
      config: f.config,
      db,
      chat,
      doorbell: doorbellFake(false).port,
      tracker: nullTracker,
      people: configPeople(f.config.people),
      log: f.log,
      now: () => time,
    });
  }

  async function attach(db: HubDb) {
    const chat = new FakeChatPort(f.config.slack.teamId);
    const ctx = context(db, chat);
    const core = createCoreBase(ctx);
    const worker = createEffectWorker(ctx);
    await chat.start(core.chatHandlers);
    chat.provisionSummary(ref.channelId, publicationKey, ref);

    function bind(person: Person = a, name = "bound-effects") {
      const owner =
        person.personId === a.personId ? caller : { person, tokenId: "tok_b" };
      const bridge = new FakeHostBridge(fakeHostCore(core), {
        person,
        hostInstanceId:
          person.personId === a.personId ? host.hostInstanceId : "hst_b",
      });
      return { ...bridge.start(name, "startup"), owner };
    }

    async function workRequest(
      owner: Caller,
      sessionId: string,
      issueId: string,
    ) {
      const { askId } = value(
        await core.ask(owner, {
          sessionId,
          projectId: p1,
          kind: "work_request",
          requestedAction: "work",
          issueId,
          question,
          expiresInMinutes: 1,
        }),
      );
      return askId;
    }

    async function answer(owner: Caller, askId: string, choice: string) {
      const personId = owner.person.personId;
      const userId = ctx.deps.people.byPersonId(personId)?.slackUserId;
      if (!userId) throw new Error("The fixture needs a chat identity");
      const action = button(askId, "answer-" + askId, userId, choice);
      const delivery = db
        .prepare(
          "SELECT channel_id, chat_thread_id, chat_message_id FROM ask_deliveries WHERE ask_id = ? AND person_id = ?",
        )
        .get(askId, personId);
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
    }

    async function answerChoice(
      to: readonly string[] = [a.personId],
      issueId?: string,
    ) {
      const { sessionId } = bind();
      const { askId } = value(
        await core.ask(caller, {
          sessionId,
          projectId: p1,
          kind: "choice",
          requestedAction: "choice",
          to,
          question,
          choices,
          ...(issueId === undefined ? {} : { issueId }),
        }),
      );
      await answer(caller, askId, "first");
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
      bind,
      workRequest,
      answer,
      answerChoice,
      report: createReport(ctx, worker),
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
      peerReport: () => createReport(context(openDb(f.path), chat), worker),
    };
  }

  const initial = await attach(f.db);
  seedHost(f.db);
  f.db
    .prepare(
      "INSERT INTO host_keys (host_instance_id,person_id,label,key_hash,created_at) VALUES ('hst_b',?,'fixture','hash_hst_b',1)",
    )
    .run(b.personId);
  return initial;
}
