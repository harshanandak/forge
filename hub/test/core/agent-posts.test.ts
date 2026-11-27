import { expect, test } from "bun:test";
import { createCoreContext } from "../../src/core/core.ts";
import { baseFixture, type BaseFixture } from "./base-fixture.ts";
import { refusal } from "./base-fakes.ts";
import { value } from "./fixture.ts";

const journal = (f: BaseFixture) =>
  f.rows("meta WHERE key LIKE 'agent-post:%'");
const transcripts = (f: BaseFixture) =>
  f.col("thread_messages WHERE kind = 'agent' ORDER BY seq", "chat_message_id");

async function setup() {
  const f = await baseFixture();
  const alpha = f.bind();
  await f.emit("root");
  const conversationId = f.read(alpha.sessionId).items[0]!.conversationId!;
  const reply = (text: string, core = f.core) =>
    core.reply(f.caller(), {
      sessionId: alpha.sessionId,
      conversationId,
      text,
    });
  return { f, reply };
}

for (const abandon of [false, true]) {
  test(
    abandon
      ? "rebuilt core recovers an abandoned reservation without posting to Slack"
      : "reservation is durable before a Slack attempt and creates no transcript row",
    async () => {
      const { f, reply } = await setup();
      const enter = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const post = f.chat.postText.bind(f.chat);
      f.chat.postText = async (...args) => {
        enter.resolve();
        await release.promise;
        return post(...args);
      };
      const attempt = reply("agent text");
      await enter.promise;
      await f.follow("member during write");
      const pending = journal(f);
      const rows = transcripts(f);
      if (abandon) f.chat.nextWrite = { kind: "refused" };
      release.resolve();
      await attempt;
      expect(pending).toHaveLength(1);
      expect(JSON.parse(String(pending[0]!.value)) as unknown).toMatchObject({
        phase: "reserved",
        text: "Fixture Alpha's agent: agent text",
      });
      expect(rows).toEqual([]);
      expect(journal(f)).toEqual([]);
      if (!abandon) return;
      f.db
        .prepare("INSERT INTO meta (key,value) VALUES (?,?)")
        .run(pending[0]!.key!, pending[0]!.value!);
      const before = f.chat.calls.length;
      createCoreContext(f.deps);
      expect(transcripts(f)).toEqual([
        expect.stringMatching(/^unconfirmed:.{36}$/),
      ]);
      expect(journal(f)).toEqual([]);
      expect(f.chat.calls).toHaveLength(before);
    },
  );
}

for (const phase of ["confirmed", "unknown", "refused"] as const) {
  test(
    phase === "refused"
      ? "replay discards a definite refusal without consuming a slot"
      : `replay inserts a ${phase} post once and projection and journal deletion roll back together`,
    async () => {
      const { f, reply } = await setup();
      f.db.exec(
        "CREATE TRIGGER block_cleanup BEFORE DELETE ON meta WHEN OLD.key LIKE 'agent-post:%' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END",
      );
      if (phase !== "confirmed") f.chat.nextWrite = { kind: phase };
      const result = await reply("agent text");
      if (phase === "confirmed")
        expect(value(result).chatMessageId).toBe("message-1");
      else
        expect(refusal(result).retry).toBe(
          phase === "refused" ? "safe" : "reconcile_first",
        );
      expect(transcripts(f)).toEqual([]);
      expect(journal(f)).toHaveLength(1);
      expect(JSON.parse(String(journal(f)[0]!.value)) as unknown).toMatchObject(
        { phase },
      );
      f.db.exec("DROP TRIGGER block_cleanup");
      const before = f.chat.calls.length;
      createCoreContext(f.deps);
      createCoreContext(f.deps);
      const expected = {
        confirmed: ["message-1"],
        unknown: [expect.stringMatching(/^unconfirmed:.{36}$/)],
        refused: [],
      };
      expect(transcripts(f)).toEqual(expected[phase]);
      expect(journal(f)).toEqual([]);
      expect(f.chat.calls).toHaveLength(before);
    },
  );
}

for (const failures of [1, 2]) {
  test(`a failed journal write preserves the known outcome for the next entry (${failures} failures)`, async () => {
    const { f, reply } = await setup();
    const prepare = f.db.prepare.bind(f.db);
    let remaining = failures;
    f.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (!/^(?:UPDATE|INSERT INTO) meta/.test(sql)) return statement;
      return {
        ...statement,
        run: (...params) => {
          if (
            remaining &&
            params.some(
              (value) =>
                typeof value === "string" &&
                value.includes('"phase":"refused"'),
            )
          ) {
            remaining--;
            throw new Error("injected outcome failure");
          }
          return statement.run(...params);
        },
      };
    };
    f.chat.nextWrite = { kind: "refused" };
    const result = await reply("refused text");
    expect(refusal(result).retry).toBe(
      failures === 1 ? "safe" : "reconcile_first",
    );
    expect(journal(f)).toHaveLength(failures - 1);
    expect(remaining).toBe(0);
    expect(value(await reply("next text")).chatMessageId).toBe("message-1");
    expect(transcripts(f)).toEqual(["message-1"]);
    expect(journal(f)).toEqual([]);
    expect(f.posts()).toEqual(["Fixture Alpha's agent: next text"]);
  });
}
