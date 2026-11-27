import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { ASK_ACTION_PREFIX } from "../../src/contract/chat.ts";
import { closeDb, fixture } from "./fixture.ts";

const timeout = 30_000;
const entry = new URL("../../dist/core/index.js", import.meta.url).href;
const storeModule = new URL("../../dist/core/store-impl.js", import.meta.url)
  .href;

test(
  "N1: selected Node migrates SQLite and preserves the answer lock across processes",
  async () => {
    const { path, config, db } = await fixture();
    closeDb(db);
    await unlink(path);
    function run(askId?: string) {
      const program = `
      import { openHubDb, createPeopleDirectory } from ${JSON.stringify(entry)};
      import { createCoreStore } from ${JSON.stringify(storeModule)};
      const config = ${JSON.stringify(config)};
      const people = createPeopleDirectory(config.people);
      const db = openHubDb(${JSON.stringify(path)});
      const ref = { channelId: "dm-node", chatMessageId: "node-card", chatThreadId: "dm-node" };
      const chat = { capabilities: { buttons: true }, postAskDm: async () => ref };
      try {
        const core = createCoreStore({ db, config, people, chat, now: () => 1234,
          log: { info() {}, warn() {}, error() {} } });
        const person = people.byPersonId("per_a");
        let askId = ${JSON.stringify(askId)};
        if (!askId) {
          core.syncDirectory();
          const session = core.sessions.createUnboundSession(person, "prj_one", "t3");
          const ask = await core.asks.ask({ person, tokenId: "tok_node" }, {
            sessionId: session.sessionId, projectId: "prj_one", kind: "work_request",
            requestedAction: "work", issueId: "node-proof", question: "May I start the proof?",
          });
          if (!ask.ok) throw Error(ask.error.code);
          askId = ask.value.askId;
        }
        const result = core.asks.answerAction({ value: askId, message: ref,
          slackUserId: "U00000001", actionId: "${ASK_ACTION_PREFIX}approve", eventKey: ${JSON.stringify(askId ? "node-2" : "node-1")} });
        const outcome = result.after ? "locked" :
          result.reply.ephemeralText?.startsWith("Already answered by ") ? "already_answered" : result.reply;
        const count = db.prepare("SELECT count(*) AS count FROM ask_answers").get().count;
        console.log(JSON.stringify({ askId, outcome, count }));
      } finally { db.close(); }
    `;
      const result = spawnSync(
        "node",
        ["--input-type=module", "--eval", program],
        { encoding: "utf8", timeout, windowsHide: true },
      );
      if (result.status !== 0)
        throw new Error(result.error?.message ?? result.stderr);
      return JSON.parse(result.stdout) as {
        askId: string;
        outcome: string;
        count: number;
      };
    }
    const first = run();
    expect(first).toMatchObject({ outcome: "locked", count: 1 });
    expect(run(first.askId)).toEqual({
      askId: first.askId,
      outcome: "already_answered",
      count: 1,
    });
  },
  timeout,
);
