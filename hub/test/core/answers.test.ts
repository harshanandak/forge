import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { createCoreStore } from "../../src/core/store-impl.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { a, b, closeDb, openDb, p1, value } from "./fixture.ts";
import {
  askFixture,
  asksOf,
  button,
  digit,
  rows,
  slackA,
  slackB,
} from "./fakes.ts";

const timeout = 30_000;
const winner =
  "Already answered by Fixture Alpha at 00:00 UTC: Choose the first option.";

test(
  "A1: two clickers lock once and queue both edits",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    const post = (key: string, user: string) =>
      Promise.resolve().then(() =>
        f.asks.answerAction(button(askId, key, user)),
      );
    const [first, second] = await Promise.all([
      post("A1a", slackA),
      post("A1b", slackB),
    ]);
    expect(first.after).toMatchObject({
      askId,
      fromPersonId: a.personId,
      queuedEdits: true,
    });
    expect(second.reply.ephemeralText).toBe(winner);
    expect(rows(f.db, "ask_answers")).toHaveLength(1);
    expect(rows(f.db, "answer_attempts")).toHaveLength(2);
    expect(
      f.asks
        .pendingEdits(10)
        .map((x) => x.personId)
        .sort(),
    ).toEqual([a.personId, b.personId]);
  },
  timeout,
);

test(
  "A2: two event keys from one clicker record two attempts",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    expect(f.asks.answerAction(button(askId, "A2a")).after?.askId).toBe(askId);
    expect(f.asks.answerAction(button(askId, "A2b")).reply.ephemeralText).toBe(
      winner,
    );
    expect(rows(f.db, "ask_answers")).toHaveLength(1);
    expect(rows(f.db, "answer_attempts").map((x) => x.outcome)).toEqual([
      "locked",
      "already_answered",
    ]);
  },
  timeout,
);

test(
  "A3: retry uses the stored outcome without queuing another edit",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice({ to: [a.personId] }));
    const event = button(askId, "A3");
    const first = f.asks.answerAction(event);
    expect(first.after?.queuedEdits).toBe(true);
    f.asks.markEditDone(askId, a.personId);
    const retry = f.asks.answerAction(event);
    expect(retry.reply).toEqual(first.reply);
    expect(retry.after).toBeUndefined();
    expect(rows(f.db, "answer_attempts")).toMatchObject([
      { outcome: "locked" },
    ]);
    expect(rows(f.db, "ask_edit_effects")).toMatchObject([{ status: "done" }]);
  },
  timeout,
);

test(
  "A4: a second open database handle sees the persisted winner",
  async () => {
    const f = await askFixture();
    const other = asksOf(createCoreStore({ ...f.deps, db: openDb(f.path) }));
    const { askId } = value(await f.choice());
    expect(other.answerAction(button(askId, "A4a")).after?.askId).toBe(askId);
    expect(
      f.asks.answerAction(button(askId, "A4b", slackB)).reply.ephemeralText,
    ).toBe(winner);
    expect(rows(f.db, "ask_answers")).toHaveLength(1);
  },
  timeout,
);

const workerSource = `
  const { parentPort, workerData: w } = require("node:worker_threads");
  (async () => {
    const { openHubDb, createPeopleDirectory } = await import(w.entry);
    const { createCoreStore } = await import(w.store);
    const { createPathProtection } = await import(new URL("./protect.js", w.entry).href);
    const { spawnSync } = require("node:child_process");
    const { dirname } = require("node:path");
    const probe = { root: process.env.SystemRoot ?? null, status: null, stdout: "", stderr: "" };
    const protection = createPathProtection({
      execute(executable, args, options) {
        const result = spawnSync(executable, args, options);
        probe.status = result.status;
        probe.stdout = result.stdout?.slice(0, 200) ?? "";
        probe.stderr = result.stderr?.slice(0, 200) ?? "";
        probe.error = result.error?.code ?? null;
        return result;
      },
    });
    const accepted = protection.protectDirectoryChain(dirname(w.path));
    parentPort.postMessage({
      probe, accepted, rootPresent: probe.root !== null, successMarker: probe.stdout.trim() === "private",
    });
    const db = openHubDb(w.path);
    try {
      const people = createPeopleDirectory(w.config.people);
      const asks = createCoreStore({ db, config: w.config, people, now: () => 1234,
        log: { info() {}, warn() {}, error() {} }, chat: {} }).asks;
      const barrier = new Int32Array(w.gate);
      parentPort.postMessage("ready");
      Atomics.wait(barrier, 0, 0, w.timeout);
      parentPort.postMessage(w.events.map(event => {
        const result = asks.answerAction(event);
        return result.after ? "locked" :
          result.reply.ephemeralText?.startsWith("Already answered by ") ? "already_answered" : result;
      }));
    } finally { db.close(); }
  })().catch(error => { parentPort.postMessage({ error: String(error) }); process.exitCode = 1; });
`;

test(
  "A5: independent worker connections contend for twenty locks",
  async () => {
    const f = await askFixture();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(value(await f.choice()).askId);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const workers: Worker[] = [];
    let ready = 0;
    try {
      const answers = await Promise.all(
        [slackA, slackB].map(
          (user) =>
            new Promise<unknown[]>((resolve, reject) => {
              const worker = new Worker(workerSource, {
                eval: true,
                workerData: {
                  path: f.path,
                  config: f.config,
                  gate: gate.buffer,
                  timeout,
                  entry: new URL("../../dist/core/index.js", import.meta.url)
                    .href,
                  store: new URL(
                    "../../dist/core/store-impl.js",
                    import.meta.url,
                  ).href,
                  events: ids.map((id, index) =>
                    button(id, user + index, user),
                  ),
                },
              });
              workers.push(worker);
              worker.on("message", (message: unknown) => {
                if (
                  message &&
                  typeof message === "object" &&
                  "probe" in message
                ) {
                  console.log(
                    "A5 parent-chain probe " + JSON.stringify(message),
                  );
                  return;
                }
                if (message === "ready") {
                  if (++ready === 2) {
                    Atomics.store(gate, 0, 1);
                    Atomics.notify(gate, 0, 2);
                  }
                } else if (Array.isArray(message)) resolve(message);
                else reject(new Error(JSON.stringify(message)));
              });
              worker.once("error", reject);
              worker.once("exit", (code) =>
                reject(new Error("Worker stopped: " + code)),
              );
            }),
        ),
      );
      expect(answers.flat().sort()).toEqual([
        ...Array<string>(20).fill("already_answered"),
        ...Array<string>(20).fill("locked"),
      ]);
      expect(rows(f.db, "ask_answers")).toHaveLength(20);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0, 2);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
  timeout,
);

test(
  "A6: restarting before the answer keeps both original edit refs",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    closeDb(f.db);
    const db = openDb(f.path);
    const asks = asksOf(
      createCoreStore({ ...f.deps, db, chat: new FakeChatPort() }),
    );
    expect(asks.answerAction(button(askId, "A6")).after?.askId).toBe(askId);
    expect(asks.answerRows(f.sessionId, 10)).toMatchObject([
      { view: { askId, choiceId: "first" }, delivered: false, acked: false },
    ]);
    expect(
      asks
        .pendingEdits(10)
        .map((x) => x.ref.chatMessageId)
        .sort(),
    ).toEqual(["message-1", "message-2"]);
  },
  timeout,
);

test(
  "A7: restarting after the answer keeps the original winner",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    expect(f.asks.answerAction(button(askId, "A7a")).after?.askId).toBe(askId);
    const before = rows(f.db, "ask_answers");
    closeDb(f.db);
    const db = openDb(f.path);
    const asks = asksOf(
      createCoreStore({ ...f.deps, db, chat: new FakeChatPort() }),
    );
    expect(
      asks.answerAction(button(askId, "A7b", slackB)).reply.ephemeralText,
    ).toBe(winner);
    expect(rows(db, "ask_answers")).toEqual(before);
  },
  timeout,
);

test(
  "A8: a failing permit insert rolls back the answer and every dependent write",
  async () => {
    const f = await askFixture();
    const sessionId = f.store.sessions.createUnboundSession(
      a,
      p1,
      "t3",
    ).sessionId;
    const { askId } = value(await f.request({ sessionId }));
    const fault = {
      ...f.db,
      prepare(sql: string) {
        const stmt = f.db.prepare(sql);
        if (!/\binsert\s+into\s+permits\b/i.test(sql)) return stmt;
        return {
          get: stmt.get.bind(stmt),
          all: stmt.all.bind(stmt),
          run() {
            throw new Error("permit insert fault");
          },
        };
      },
    };
    const asks = asksOf(createCoreStore({ ...f.deps, db: fault }));
    expect(() =>
      asks.answerAction(button(askId, "A8", slackA, "approve")),
    ).toThrow("permit insert fault");
    expect(rows(f.db, "asks")).toMatchObject([{ status: "open" }]);
    for (const table of [
      "ask_answers",
      "permits",
      "answer_attempts",
      "ask_edit_effects",
    ] as const)
      expect(rows(f.db, table)).toEqual([]);
    expect(f.store.sessions.session(sessionId)?.mode).toBe("reply_only");
  },
  timeout,
);

test(
  "A9: button and digit must name a choice on the ask",
  async () => {
    const f = await askFixture();
    const { askId } = value(await f.choice());
    const text = "That choice is not on this ask.";
    expect(
      f.asks.answerAction(button(askId, "A9", slackA, "missing")).reply
        .ephemeralText,
    ).toBe(text);
    expect(f.asks.answerDigit(digit(askId + " 4"))).toMatchObject({
      kind: "answered",
      outcome: { kind: "invalid_choice" },
      ephemeralText: text,
    });
    expect(rows(f.db, "ask_answers")).toEqual([]);
    expect(rows(f.db, "answer_attempts").map((x) => x.outcome)).toEqual([
      "invalid_choice",
      "invalid_choice",
    ]);
  },
  timeout,
);

test(
  "A10: expiry, removed members and unknown identities are refused",
  async () => {
    const f = await askFixture();
    const former = value(await f.choice());
    const restricted = value(await f.choice({ to: [b.personId] }));
    f.setTime(Date.parse(former.expiresAt));
    expect(
      f.asks.answerAction(button(former.askId, "late")).reply.ephemeralText,
    ).toBe("This ask has expired.");
    expect(f.asks.pendingEdits(10)).toHaveLength(2);
    f.setTime(1234);
    const recorded = value(await f.choice());
    const replay = button(recorded.askId, "before-removal", slackB);
    f.asks.answerAction(button(recorded.askId, "winner"));
    expect(f.asks.answerAction(replay).reply.ephemeralText).toBe(winner);
    const cases = [
      [restricted.askId, "other", slackA, "This ask is for Fixture Beta."],
      [restricted.askId, "removed", slackB, "This ask is for Fixture Beta."],
      [
        restricted.askId,
        "unknown",
        "U00000000",
        "You are not set up in Forge for this workspace.",
      ],
      ["ask_unknown", "missing", slackA, "This ask no longer exists."],
    ] as const;
    for (const [id, key, user, text] of cases) {
      if (key === "removed")
        f.db
          .prepare(
            "DELETE FROM project_members WHERE project_id = ? AND person_id = ?",
          )
          .run(p1, b.personId);
      expect(
        f.asks.answerAction(button(id, key, user)).reply.ephemeralText,
      ).toBe(text);
    }
    for (const event of [
      replay,
      button(recorded.askId, "after-removal", slackB),
    ])
      expect(f.asks.answerAction(event).reply.ephemeralText).toBe(
        "This ask is for Fixture Alpha, Fixture Beta.",
      );
    expect(rows(f.db, "asks").map((x) => x.status)).toEqual([
      "expired",
      "open",
      "answered",
    ]);
    expect(rows(f.db, "ask_answers").map((x) => x.ask_id)).toEqual([
      recorded.askId,
    ]);
    expect(rows(f.db, "answer_attempts").map((x) => x.outcome)).toEqual([
      "expired",
      "locked",
      "already_answered",
      "not_allowed",
      "not_allowed",
      "unknown_answerer",
      "unknown_ask",
      "not_allowed",
    ]);
  },
  timeout,
);
