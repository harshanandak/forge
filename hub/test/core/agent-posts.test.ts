import { expect, test } from "bun:test";
import { SECRET_REMOVED_TEXT } from "../../src/contract/errors.ts";
import { LIMITS, LONG_ANSWER_SEPARATOR } from "../../src/contract/mcp.ts";
import {
  recoverAgentPosts,
  reserveAgentPost,
} from "../../src/core/agent-posts.ts";
import { createCoreContext } from "../../src/core/core.ts";
import { byConversation } from "../../src/core/thread.ts";
import { baseFixture, seedThread, type BaseFixture } from "./base-fixture.ts";
import { observePostJournal } from "./base-fixture.ts";
import { refusal } from "./base-fakes.ts";
import { a, b, p1, value } from "./fixture.ts";
import { secretCaller, secretName } from "./fixture.ts";

const timeout = 30_000;
const journal = (f: BaseFixture) =>
  f.rows("meta WHERE key LIKE 'agent-post:%'");
const transcripts = (f: BaseFixture) =>
  f.col("thread_messages WHERE kind = 'agent' ORDER BY seq", "chat_message_id");

function expectUnknownTranscript(f: BaseFixture) {
  const ids = transcripts(f);
  expect(ids).toHaveLength(1);
  expect(String(ids[0])).toMatch(/^unconfirmed:.{36}$/);
}

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
  return { f, alpha, conversationId, reply };
}

test.each(["thread", "project", "long fallback"] as const)(
  "%s reply redacts the name in its label, post and stored text",
  async (form) => {
    const { f, alpha, conversationId } = await setup();
    const project = form === "project";
    const long = form === "long fallback";
    if (long) f.chat.nextWrite = { kind: "refused" };
    const name = SECRET_REMOVED_TEXT;
    const label = `Forge (${name}'s agent)`;
    const fallback = `Summary (The full answer could not be posted as a canvas. Ask ${name}'s agent for the detail.)`;
    const body = `${name}'s agent: ${long ? fallback : "Reply"}`;
    const reserved = observePostJournal(f);
    const caller = f.caller(secretCaller.person);
    const result = value(
      await f.core.reply(caller, {
        sessionId: alpha.sessionId,
        ...(project ? { projectId: p1 } : { conversationId }),
        text: long ? `Summary\n${LONG_ANSWER_SEPARATOR}\nDetails` : "Reply",
      }),
    );
    const [, posted, options] = f.writes("postText")[0]!.args;
    expect(reserved()).toHaveLength(project ? 0 : 1);
    expect([
      result.postedAs === label,
      JSON.stringify(options) === JSON.stringify({ agentLabel: label }),
      posted === body,
      project || String(reserved()[0]).includes(JSON.stringify(body)),
      f.col("thread_messages WHERE kind = 'agent'", "text")[0] === body,
    ]).toEqual([true, true, true, true, true]);
  },
  timeout,
);

const phases = ["reserved", "unknown", "confirmed", "refused"] as const;
test.each([...phases, "ordinary"] as const)(
  "journal replay preserves identity and applies the text policy for %s",
  async (mode) => {
    const { f, alpha, conversationId } = await setup();
    const ctx = f.context;
    const chat = byConversation(f.db, conversationId)!;
    const { chatThreadId, channelId } = chat;
    const { sessionId } = alpha;
    const { personId } = a;
    const ordinary = "Ordinary reply";
    const post = reserveAgentPost(ctx, chat, sessionId, personId, ordinary)!;
    const phase = mode === "ordinary" ? "reserved" : mode;
    const ref = { chatThreadId, channelId, chatMessageId: "legacy-confirmed" };
    const at = post.at - 100;
    const text =
      mode === "ordinary" ? ordinary : `${secretName}'s agent: Reply`;
    const payload = JSON.stringify({ ...post, phase, ref, at, text });
    const put = f.db.prepare("REPLACE INTO meta (key,value) VALUES (?,?)");
    for (let replay = 0; replay < 2; replay++) {
      put.run("agent-post:" + chatThreadId, payload);
      recoverAgentPosts(ctx, mode === "unknown" ? chatThreadId : undefined);
      expect(journal(f)).toEqual([]);
    }
    expect(f.writes("postText")).toEqual([]);
    const rows = f.rows("thread_messages WHERE kind = 'agent'");
    expect(rows).toHaveLength(mode === "refused" ? 0 : 1);
    if (mode === "refused") return;
    const { text: stored, ...identity } = rows[0]!;
    expect(identity).toMatchObject({
      chat_message_id: mode === "confirmed" ? ref.chatMessageId : post.id,
      person_id: personId,
      session_id: sessionId,
      project_id: p1,
      created_at: at,
    });
    const expected = mode === "ordinary" ? text : SECRET_REMOVED_TEXT;
    expect(stored === expected).toBe(true);
  },
  timeout,
);

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
      expectUnknownTranscript(f);
      expect(journal(f)).toEqual([]);
      expect(f.chat.calls).toHaveLength(before);
    },
    timeout,
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
      if (phase === "unknown") expectUnknownTranscript(f);
      else
        expect(transcripts(f)).toEqual(
          phase === "confirmed" ? ["message-1"] : [],
        );
      expect(journal(f)).toEqual([]);
      expect(f.chat.calls).toHaveLength(before);
    },
    timeout,
  );
}

for (const failures of [1, 2]) {
  test(
    `a failed journal write preserves the known outcome for the next entry (${failures} failures)`,
    async () => {
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
    },
    timeout,
  );
}

test(
  "a visible send keeps its inbox receipt when the outcome cannot be journaled",
  async () => {
    const { f, alpha, conversationId, reply } = await setup();
    const beta = f.bind(b, "bound-b", "beta");
    for (let index = 0; index < LIMITS.agentRunMax - 1; index++)
      seedThread(
        f,
        "agent-" + index,
        "run",
        "agent",
        a.personId,
        alpha.sessionId,
      );
    f.db.exec(
      "CREATE TRIGGER block_outcome BEFORE UPDATE ON meta WHEN NEW.key LIKE 'agent-post:%' BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END",
    );
    const sent = await f.core.send(f.caller(), {
      sessionId: alpha.sessionId,
      projectId: p1,
      toPersonId: b.personId,
      conversationId,
      text: "agent note",
    });
    const items = f.read(beta.sessionId, b).items;
    expect(items.map((item) => item.text)).toEqual(["agent note"]);
    expect(sent).toEqual({
      ok: true,
      value: { itemId: items[0]!.itemId, threadPost: "failed" },
    });
    expect(transcripts(f)).toHaveLength(LIMITS.agentRunMax - 1);
    expect(journal(f)).toHaveLength(1);
    f.db.exec("DROP TRIGGER block_outcome");
    expect(refusal(await reply("over limit"))).toMatchObject({
      code: "CONVERSATION_PAUSED",
      retry: "never",
    });
    expect(transcripts(f)).toHaveLength(LIMITS.agentRunMax);
    expect(transcripts(f).filter((id) => id === "message-1")).toEqual([
      "message-1",
    ]);
    expect(journal(f)).toEqual([]);
    expect(f.posts()).toEqual([
      "Fixture Alpha's agent asked Fixture Beta's agent: agent note",
      "Paused: the agents need a person to reply.",
    ]);
  },
  timeout,
);
