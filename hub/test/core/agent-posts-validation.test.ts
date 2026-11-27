import { expect, test } from "bun:test";
import { recoverAgentPosts } from "../../src/core/agent-posts.ts";
import { createCoreContext } from "../../src/core/core.ts";
import { baseFixture, thread, type BaseFixture } from "./base-fixture.ts";
import { slackB } from "./fakes.ts";
import { value } from "./fixture.ts";

const timeout = 30_000;
const threadB = "slack:C00000001:20.000001";
const journalKey = (threadId: string) => "agent-post:" + threadId;

function conversationId(f: BaseFixture, threadId: string) {
  const row = f.db
    .prepare(
      "SELECT conversation_id FROM conversations WHERE chat_thread_id = ?",
    )
    .get(threadId);
  const id = row?.conversation_id;
  if (typeof id !== "string") throw new Error("Conversation missing");
  return id;
}

function journalValues(f: BaseFixture, key: string) {
  return f.col("meta WHERE key = ?", "value", key).map(String);
}

function transcriptIds(f: BaseFixture, threadId: string) {
  return f.col(
    "thread_messages WHERE kind = 'agent' AND chat_thread_id = ? ORDER BY seq",
    "chat_message_id",
    threadId,
  );
}

async function setupThreads() {
  const f = await baseFixture();
  const alpha = f.bind();
  await f.emit("root-a", { chatThreadId: thread });
  await f.emit("root-b", { chatThreadId: threadB });
  const reply = (threadId: string, text: string) =>
    f.core.reply(f.caller(), {
      sessionId: alpha.sessionId,
      conversationId: conversationId(f, threadId),
      text,
    });
  return {
    f,
    reply,
    replyB: (text: string) => reply(threadB, text),
  };
}

function caught(run: () => unknown) {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

test(
  "startup skips invalid journal json and recovers other threads",
  async () => {
    const { f, replyB } = await setupThreads();
    f.db.exec(
      "CREATE TRIGGER block_cleanup BEFORE DELETE ON meta WHEN OLD.key LIKE 'agent-post:%' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END",
    );
    expect(value(await replyB("valid outcome")).chatMessageId).toBe(
      "message-1",
    );
    expect(journalValues(f, journalKey(threadB))).toHaveLength(1);
    f.db.exec("DROP TRIGGER block_cleanup");
    f.db
      .prepare("INSERT INTO meta (key,value) VALUES (?,?)")
      .run(journalKey(thread), "{not json");

    createCoreContext(f.deps);

    expect(transcriptIds(f, threadB)).toEqual(["message-1"]);
    expect(journalValues(f, journalKey(thread))).toEqual(["{not json"]);
    expect(f.logged).toContainEqual([
      "agent_post_journal_invalid",
      { key: journalKey(thread) },
    ]);
  },
  timeout,
);

test(
  "startup keeps a key mismatch row and never uses its parsed thread for deletion",
  async () => {
    const { f, replyB } = await setupThreads();
    f.db.exec(
      "CREATE TRIGGER block_cleanup BEFORE DELETE ON meta WHEN OLD.key LIKE 'agent-post:%' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END",
    );
    expect(value(await replyB("valid outcome")).chatMessageId).toBe(
      "message-1",
    );
    f.db.exec("DROP TRIGGER block_cleanup");
    const valid = journalValues(f, journalKey(threadB))[0];
    if (valid === undefined) throw new Error("Journal row missing");
    f.db
      .prepare("INSERT INTO meta (key,value) VALUES (?,?)")
      .run(journalKey(thread), valid);

    createCoreContext(f.deps);

    expect(transcriptIds(f, threadB)).toEqual(["message-1"]);
    expect(journalValues(f, journalKey(threadB))).toEqual([]);
    expect(journalValues(f, journalKey(thread))).toEqual([valid]);
    expect(f.logged).toContainEqual([
      "agent_post_journal_invalid",
      { key: journalKey(thread) },
    ]);
  },
  timeout,
);

test(
  "an invalid per-thread row fails closed without blocking another thread",
  async () => {
    const { f, reply } = await setupThreads();
    f.db
      .prepare("INSERT INTO meta (key,value) VALUES (?,?)")
      .run(journalKey(thread), "{not json");

    const failure = caught(() => recoverAgentPosts(f.context, thread));
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.name : "").toBe(
      "AgentPostJournalError",
    );

    const writes = f.posts().length;
    const blocked = await reply(thread, "blocked");
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "CHAT_UNAVAILABLE" },
    });
    expect(f.posts()).toHaveLength(writes);
    expect(transcriptIds(f, thread)).toEqual([]);
    expect(journalValues(f, journalKey(thread))).toEqual(["{not json"]);

    expect(value(await reply(threadB, "still works")).chatMessageId).toBe(
      "message-1",
    );
    expect(f.posts().at(-1)).toBe("Fixture Alpha's agent: still works");
  },
  timeout,
);

test(
  "an inbound member message is recorded when the thread journal row is invalid",
  async () => {
    const { f } = await setupThreads();
    f.db
      .prepare("INSERT INTO meta (key,value) VALUES (?,?)")
      .run(journalKey(thread), "{not json");

    await f.follow("member-kept", {
      slackUserId: slackB,
      mentionsBot: false,
      threadRootMessageId: "root-a",
    });

    expect(
      f.col(
        "thread_messages WHERE chat_thread_id = ? AND kind = 'person'",
        "text",
        thread,
      ),
    ).toContain("member-kept");
    expect(journalValues(f, journalKey(thread))).toEqual(["{not json"]);
  },
  timeout,
);

type ValidationFixture = Awaited<ReturnType<typeof baseFixture>>;
type ReplyForTest = (
  threadId: string,
  text: string,
) => ReturnType<ValidationFixture["core"]["reply"]>;

async function holdConfirmedJournal(
  f: ValidationFixture,
  reply: ReplyForTest,
  threadId: string,
  text: string,
) {
  f.db.exec(
    "CREATE TRIGGER block_cleanup BEFORE DELETE ON meta WHEN OLD.key LIKE 'agent-post:%' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END",
  );
  try {
    return value(await reply(threadId, text)).chatMessageId;
  } finally {
    f.db.exec("DROP TRIGGER block_cleanup");
  }
}

function rewriteJournal(
  f: BaseFixture,
  key: string,
  rewrite: (value: string) => string,
) {
  const stored = journalValues(f, key)[0];
  if (stored === undefined) throw new Error("Journal row missing");
  const replacement = rewrite(stored);
  if (replacement === stored) throw new Error("Journal rewrite did not apply");
  f.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(replacement, key);
}

test(
  "startup keeps a row whose projection fails and recovers other threads",
  async () => {
    const { f, reply } = await setupThreads();
    expect(f.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(await holdConfirmedJournal(f, reply, thread, "bad outcome")).toBe(
      "message-1",
    );
    expect(await holdConfirmedJournal(f, reply, threadB, "valid outcome")).toBe(
      "message-2",
    );
    rewriteJournal(f, journalKey(thread), (stored) => {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      parsed.sessionId = "missing-session";
      return JSON.stringify(parsed);
    });

    createCoreContext(f.deps);

    expect(transcriptIds(f, thread)).toEqual([]);
    expect(transcriptIds(f, threadB)).toEqual(["message-2"]);
    expect(journalValues(f, journalKey(thread))).toHaveLength(1);
    expect(journalValues(f, journalKey(threadB))).toEqual([]);
    expect(f.logged).toContainEqual([
      "agent_post_journal_projection_failed",
      { key: journalKey(thread) },
    ]);
  },
  timeout,
);

for (const at of ["0.5", "1e400"]) {
  test(
    `an invalid journal timestamp ${at} is kept warned and fails closed`,
    async () => {
      const { f, reply } = await setupThreads();
      expect(
        await holdConfirmedJournal(f, reply, thread, "timed outcome"),
      ).toBe("message-1");
      rewriteJournal(f, journalKey(thread), (stored) =>
        stored.replace(/"at":\d+/, `"at":${at}`),
      );

      createCoreContext(f.deps);

      expect(f.logged).toContainEqual([
        "agent_post_journal_invalid",
        { key: journalKey(thread) },
      ]);
      expect(journalValues(f, journalKey(thread))[0]).toContain(`"at":${at}`);
      const failure = caught(() => recoverAgentPosts(f.context, thread));
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.name : "").toBe(
        "AgentPostJournalError",
      );
      const writes = f.posts().length;
      const blocked = await reply(thread, "blocked");
      expect(blocked).toMatchObject({
        ok: false,
        error: { code: "CHAT_UNAVAILABLE" },
      });
      expect(f.posts()).toHaveLength(writes);
      expect(journalValues(f, journalKey(thread))).toHaveLength(1);
    },
    timeout,
  );
}
