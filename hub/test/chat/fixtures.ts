import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Chat from "../../src/contract/chat.ts";
import { CHAT_STATE_DDL } from "../../src/contract/chat-state.ts";
import type { Summary } from "../../src/contract/domain.ts";
import type * as Runtime from "../../src/contract/runtime.ts";
import { createSlackChatPort } from "../../src/chat/index.ts";
import {
  asha,
  ashaDm,
  channel,
  fakeSlackServer,
  team,
} from "../fakes/fake-slack-server.ts";

export const signingSecret = ["synthetic", "slack", "signing"].join("-");
export const sampleBotToken = ["xo", "xb", "forge-fixture"].join("-");
export const sampleAppToken = ["xo", "xa", "pp", "forge-fixture"].join("-");
export const rootTs = "1800000000.100000";
export const replyTs = "1800000000.200000";
export const ask: Chat.AskCardView = {
  askId: "ask_sample",
  kind: "choice",
  projectName: "Atlas",
  askedForName: "Ravi",
  question: "Approve the patch?",
  choices: ["Yes", "No"].map((label) => ({ id: label.toLowerCase(), label })),
  state: { kind: "open", digitFallback: false },
};
export const summary: Summary = {
  projectId: "proj_atlas",
  projectName: "Atlas",
  revision: 0,
  updatedAt: 1_800_000_000_000,
  lines: [
    {
      personId: "per_asha",
      personName: "Asha",
      state: "working",
      text: "Working on the patch",
      hostLabel: "shell",
      updatedAt: 1_800_000_000_000,
    },
  ],
};
export function messageRef(
  channelId: string,
  chatMessageId: string,
  threadTs = chatMessageId,
): Chat.ChatMessageRef {
  return {
    channelId,
    chatMessageId,
    chatThreadId: `slack:${channelId}:${threadTs}`,
  };
}

export const ref = messageRef(channel, rootTs);
const replyRef = messageRef(channel, replyTs, rootTs);
export const threadTarget = {
  kind: "thread",
  chatThreadId: ref.chatThreadId,
} as const;

export const subscribedChanges: Chat.ChatMessageChangeEvent[] = [
  { ...replyRef, kind: "edited", text: "new", fileNames: ["plan.pdf"] },
  { ...replyRef, kind: "deleted", text: "", fileNames: [] },
];

type Fields = Record<string, unknown>;
type Options = {
  readonly mode?: "webhook" | "socket";
  readonly buttons?: boolean;
  readonly disk?: boolean;
  readonly noDatabase?: boolean;
  readonly secret?: Runtime.ReadSecret;
  readonly handlers?: Partial<Chat.ChatInboundHandlers>;
};

const secrets: Partial<Record<Runtime.SecretName, string>> = {
  SLACK_BOT_TOKEN: sampleBotToken,
  SLACK_SIGNING_SECRET: signingSecret,
  SLACK_APP_TOKEN: sampleAppToken,
};
export const fixtureSecret: Runtime.ReadSecret = (name) => secrets[name];

function blockDb(): never {
  throw new Error("fixture database must not be used");
}
const blockedDb: Runtime.HubDb = {
  exec: blockDb,
  prepare: blockDb,
  transaction: blockDb,
  claimWorker: blockDb,
  close: blockDb,
};

export function testDb(path: string, initialize: boolean): Runtime.HubDb {
  const database = new Database(path);
  if (initialize) for (const sql of CHAT_STATE_DDL) database.exec(sql);
  return {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.query<Runtime.SqlRow, Runtime.SqlValue[]>(sql);
      return {
        run: (...args) => statement.run(...args),
        get: (...args) => statement.get(...args) ?? undefined,
        all: (...args) => statement.all(...args),
      };
    },
    transaction: (work) => database.transaction(work).immediate(),
    claimWorker: blockDb,
    close: () => database.close(),
  };
}

export function dm(overrides: Fields = {}): Fields {
  return {
    type: "message",
    channel_type: "im",
    channel: ashaDm,
    user: asha,
    text: "hello",
    ts: rootTs,
    ...overrides,
  };
}

export function mention(overrides: Fields = {}): Fields {
  return {
    type: "app_mention",
    channel,
    user: asha,
    text: "hello <@U0BOT>",
    ts: rootTs,
    ...overrides,
  };
}

export function callback(
  event: Fields = dm(),
  id = "Ev0ONE",
  teamId = team,
): Fields {
  return {
    type: "event_callback",
    team_id: teamId,
    event_id: id,
    authorizations: [{ team_id: teamId }],
    event,
  };
}

export function click(overrides: Fields = {}, action: Fields = {}): Fields {
  return {
    type: "block_actions",
    team: { id: team },
    team_id: team,
    trigger_id: "trigger.1",
    user: { id: asha, name: "asha" },
    channel: { id: ashaDm },
    container: { type: "message", channel_id: ashaDm, message_ts: rootTs },
    message: { ts: rootTs },
    actions: [
      {
        action_id: "forge_ask_yes",
        action_ts: replyTs,
        value: ask.askId,
        ...action,
      },
    ],
    ...overrides,
  };
}

type Signing = {
  readonly signed?: boolean;
  readonly corruptSignature?: boolean;
  readonly key?: string;
  readonly timestamp?: number;
  readonly headers?: Readonly<Record<string, string>>;
};

function delivery(payload: Fields, options: Signing = {}): Request {
  const form = payload.type === "block_actions";
  const json = JSON.stringify(payload);
  const body = form ? new URLSearchParams({ payload: json }).toString() : json;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const headers = new Headers(options.headers);
  headers.set(
    "content-type",
    form ? "application/x-www-form-urlencoded" : "application/json",
  );
  if (options.signed !== false) {
    const hash = createHmac("sha256", options.key ?? signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
    const signedHash = options.corruptSignature
      ? (hash[0] === "0" ? "1" : "0") + hash.slice(1)
      : hash;
    headers.set("x-slack-request-timestamp", String(timestamp));
    headers.set("x-slack-signature", "v0=" + signedHash);
  }
  return new Request("http://127.0.0.1" + Chat.SLACK_WEBHOOK_PATH, {
    method: "POST",
    headers,
    body,
  });
}

const previousReply = { ts: replyTs, thread_ts: rootTs, user: asha };
const updatedReply = {
  ...previousReply,
  text: "new",
  files: [{ name: "plan.pdf" }],
};
const channelMessage = { type: "message", channel, channel_type: "channel" };

export function changed(message: Fields = updatedReply): Fields {
  return {
    ...channelMessage,
    subtype: "message_changed",
    ts: "1800000000.300000",
    message,
    previous_message: { ...message, text: "old" },
  };
}

export function deleted(previousMessage: Fields = previousReply): Fields {
  return {
    ...channelMessage,
    subtype: "message_deleted",
    ts: "1800000000.400000",
    deleted_ts: replyTs,
    previous_message: previousMessage,
  };
}

export async function failure(
  work: () => Promise<unknown>,
): Promise<Chat.ChatWriteFailure> {
  try {
    await work();
  } catch (error) {
    if (error instanceof Chat.ChatWriteFailure) return error;
    throw error;
  }
  throw new Error("expected ChatWriteFailure");
}

export async function slackFixture(options: Options = {}, start = false) {
  const fake = await fakeSlackServer(options.mode === "socket");
  const fixtureUrl = new URL(fake.url);
  expect(fixtureUrl.hostname).toBe("127.0.0.1");
  expect(fixtureUrl.protocol).toBe("http:");
  expect(Number(fixtureUrl.port)).toBeGreaterThan(0);
  const directory = options.disk
    ? mkdtempSync(join(tmpdir(), "forge-slack-"))
    : undefined;
  const dbPath = directory ? join(directory, "chat.sqlite") : ":memory:";
  let db = options.noDatabase ? blockedDb : testDb(dbPath, true);
  let port: Chat.ChatPort | undefined;
  const actions: Chat.ChatActionEvent[] = [];
  const messages: Chat.ChatMessageEvent[] = [];
  const changes: Chat.ChatMessageChangeEvent[] = [];
  const logs: Array<{ event: string; fields?: Runtime.LogFields }> = [];
  const record: Runtime.HubLog["info"] = (event, fields) => {
    logs.push(fields === undefined ? { event } : { event, fields });
  };
  const handlers: Chat.ChatInboundHandlers = {
    onAction(event) {
      actions.push(event);
      return options.handlers?.onAction?.(event) ?? Promise.resolve({});
    },
    onMessage(event) {
      messages.push(event);
      return options.handlers?.onMessage?.(event) ?? Promise.resolve();
    },
    onMessageChange(event) {
      changes.push(event);
      return options.handlers?.onMessageChange?.(event) ?? Promise.resolve();
    },
  };
  const readDeps = (): Runtime.ChatDeps => ({
    config: {
      listen: { host: "127.0.0.1", port: 0 },
      basePath: "",
      dataDir: ".",
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
      slack: {
        mode: options.mode ?? "webhook",
        buttons: options.buttons ?? true,
        teamId: team,
      },
      mcp: { enabled: false },
      hooks: { enabled: false },
      cli: { enabled: false },
      projects: [],
      people: [],
      doorbells: [],
    },
    people: {
      all: () => [],
      byPersonId: () => undefined,
      byChatUserId: () => undefined,
      bySlackUserId: () => undefined,
    },
    db,
    log: { info: record, warn: record, error: record },
    secret: options.secret ?? fixtureSecret,
    slackApiUrl: fake.url,
  });
  function assertLogFields() {
    for (const { event, fields } of logs) {
      expect(["chat.info", "chat.warn", "chat.error"]).toContain(event);
      expect(
        Object.keys(fields ?? {}).filter((key) => key !== "count"),
      ).toEqual([]);
    }
  }
  const getPort = () => (port ??= createSlackChatPort(readDeps()));
  const send = (payload: Fields, signing?: Signing) =>
    getPort().handleWebhook(delivery(payload, signing));
  const fixture = {
    fake,
    actions,
    messages,
    changes,
    logs,
    assertLogFields,
    get db() {
      return db;
    },
    deps: readDeps,
    port: getPort,
    get chat() {
      return getPort();
    },
    async start() {
      const current = getPort();
      await current.start(handlers);
      return current;
    },
    stop: () => port?.stop() ?? Promise.resolve(),
    send,
    async status(payload: Fields, signing?: Signing) {
      return (await send(payload, signing)).status;
    },
    kv: () =>
      db
        .prepare("select key from chat_kv order by key")
        .all()
        .map(({ key }) => {
          if (typeof key !== "string")
            throw new Error("expected chat state key");
          return key;
        }),
    async restart() {
      if (!directory) throw new Error("restart needs a disk fixture");
      await getPort().stop();
      db.close();
      db = testDb(dbPath, false);
      port = undefined;
      await getPort().start(handlers);
    },
    async [Symbol.asyncDispose]() {
      try {
        await port?.stop();
      } finally {
        if (!options.noDatabase) db.close();
        if (directory) {
          rmSync(dbPath, { force: true });
          rmdirSync(directory);
        }
        await fake.close();
        expect(fake.unexpected).toEqual([]);
        assertLogFields();
      }
    },
  };
  if (start) {
    try {
      await fixture.start();
    } catch (error) {
      await fixture[Symbol.asyncDispose]();
      throw error;
    }
  }
  return fixture;
}

export type SlackFixture = Awaited<ReturnType<typeof slackFixture>>;
export const startedSlack = (options?: Options) => slackFixture(options, true);

export function slackCases(
  test: typeof import("bun:test").test,
  timeout: number,
) {
  const bind =
    (start: boolean) =>
    (
      name: string,
      check: (h: SlackFixture) => void | Promise<void>,
      options?: Options,
    ) => {
      test(
        name,
        async () => {
          await using h = await slackFixture(options, start);
          await check(h);
        },
        timeout,
      );
    };
  return { started: bind(true), idle: bind(false) };
}

export function subscribed(h: SlackFixture, threadId: string) {
  const sql = "select 1 from chat_subscriptions where thread_id = ?";
  return h.db.prepare(sql).get(threadId) !== undefined;
}

export function eventKeys(h: SlackFixture) {
  return h.kv().filter((key) => /^(dedupe:|slack:event-delivered:)/.test(key));
}

export async function waitFor(check: () => boolean) {
  const deadline = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() >= deadline)
      throw new Error("expected Slack effect did not complete");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
