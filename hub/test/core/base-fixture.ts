import type { ChatMessageEvent } from "../../src/contract/chat.ts";
import type { HelloInput } from "../../src/contract/mcp.ts";
import { expect } from "bun:test";
import type { Caller } from "../../src/contract/core.ts";
import type { Person } from "../../src/contract/domain.ts";
import type {
  DoorbellConfig,
  PersonConfig,
  SqlValue,
} from "../../src/contract/runtime.ts";
import { createCoreBase, createCoreContext } from "../../src/core/core.ts";
import { nullTracker } from "../../src/core/index.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { FakeHostBridge } from "../fakes/fake-host.ts";
import { a, configPeople, fixture, p1, value } from "./fixture.ts";
import { button, choices, digit, question, slackA } from "./fakes.ts";
import { doorbellFake, fakeHostCore } from "./base-fakes.ts";

export const front = "thread-fixture";
export const channel = "C00000001";
export const thread = "slack:C00000001:10.000001";
export const unknownUser = "U00009999";

export function bellFor(
  personId: string,
  frontThreadId = front,
): DoorbellConfig {
  return {
    personId,
    projectId: p1,
    frontThreadId,
    urlEnv: "FORGE_DOORBELL_FIXTURE_URL",
    secretEnv: "FORGE_DOORBELL_FIXTURE_SECRET",
  };
}

function message(
  id: string,
  change: Partial<ChatMessageEvent> = {},
): ChatMessageEvent {
  return {
    eventKey: id,
    chatMessageId: id,
    channelId: channel,
    chatThreadId: thread,
    slackUserId: slackA,
    userName: "Unverified name",
    isBot: false,
    isDirect: false,
    mentionsBot: true,
    text: id,
    mentionedSlackUserIds: [],
    fileNames: [],
    ...change,
  };
}

export async function baseFixture(
  options: {
    ring?: boolean;
    extraPeople?: readonly PersonConfig[];
    bells?: readonly DoorbellConfig[];
  } = {},
) {
  const f = await fixture({ hooks: { enabled: true } });
  const extras = options.extraPeople ?? [];
  const people = [...f.config.people, ...extras];
  const config = {
    ...f.config,
    people,
    projects: f.config.projects.map((project) =>
      project.projectId === p1
        ? {
            ...project,
            memberIds: [...project.memberIds, ...extras.map((p) => p.personId)],
          }
        : project,
    ),
    doorbells: [...f.config.doorbells, ...(options.bells ?? [])],
  };
  const chat = new FakeChatPort(config.slack.teamId);
  const doorbell = doorbellFake(options.ring ?? false);
  let time = 1_700_000_000_000;
  let kicks = 0;
  const deps = {
    config,
    db: f.db,
    people: configPeople(people),
    now: () => time,
    log: f.log,
    doorbell: doorbell.port,
    tracker: nullTracker,
    chat,
  };
  const context = createCoreContext(deps);
  const core = createCoreBase(context, {
    kickEffects: () => {
      kicks++;
    },
  });
  await chat.start(core.chatHandlers);

  function bind(person: Person = a, name = "bound-a", threadId = front) {
    const hostInstanceId = "hst_" + person.personId;
    f.db
      .prepare(
        "INSERT OR IGNORE INTO host_keys VALUES (?,?,'fixture',?,0,NULL,NULL)",
      )
      .run(hostInstanceId, person.personId, "hash_" + hostInstanceId);
    const bridge = new FakeHostBridge(fakeHostCore(core), {
      person,
      hostInstanceId,
    });
    return {
      ...bridge.start(name, "startup", threadId),
      mode: () => bridge.mode(name),
    };
  }
  function caller(person: Person = a): Caller {
    const tokenId = "tok_" + person.personId;
    f.db
      .prepare(
        "INSERT OR IGNORE INTO tokens VALUES (?,?,'fixture',?,0,NULL,NULL)",
      )
      .run(tokenId, person.personId, "hash_" + tokenId);
    return { person, tokenId };
  }
  const bindProject = (sessionId: string, projectId = p1) =>
    value(core.hello(caller(), { sessionId, projectId, host: "claude" }));
  const choice = async (sessionId: string) =>
    value(
      await core.ask(caller(), {
        sessionId,
        projectId: p1,
        question,
        choices,
        to: [a.personId],
        kind: "choice",
        requestedAction: "choice",
      }),
    );
  const action = (askId: string, key: string) => {
    const statement = "SELECT * FROM ask_deliveries WHERE ask_id = ?";
    const delivery = f.db.prepare(statement).get(askId);
    return chat.emitAction({
      ...button(askId, key),
      message: {
        channelId: String(delivery?.channel_id),
        chatThreadId: String(delivery?.chat_thread_id),
        chatMessageId: String(delivery?.chat_message_id),
      },
    });
  };
  const unbound = (input: Partial<HelloInput> = {}, person: Person = a) =>
    value(core.hello(caller(person), { host: "claude", ...input }));
  const inbox = (
    sessionId: string,
    person: Person,
    ackItemIds: readonly string[] = [],
  ) => value(core.inbox(caller(person), { sessionId, ackItemIds }));
  const read = (id: string, person: Person = a) => inbox(id, person);
  const ack = (id: string, ids: readonly string[], person: Person = a) =>
    inbox(id, person, ids);
  const sql = (query: string, ...args: SqlValue[]) =>
    f.db.prepare(query).all(...args);
  const rows = (from: string, columns = "*", ...args: SqlValue[]) =>
    sql("SELECT " + columns + " FROM " + from, ...args);
  type Effect = (typeof chat.writes)[number]["name"];
  const writes = (name: Effect) =>
    chat.writes.filter((call) => call.name === name);
  const emit = (id: string, change?: Partial<ChatMessageEvent>) =>
    chat.emitMessage(message(id, change));
  return {
    ...f,
    config,
    deps,
    chat,
    context,
    core,
    bind,
    caller,
    bindProject,
    choice,
    action,
    kicks: () => kicks,
    rings: doorbell.rings,
    advance: (ms: number) => {
      time += ms;
    },
    now: deps.now,
    emit,
    follow: (id: string, change?: Partial<ChatMessageEvent>) =>
      emit(id, { threadRootMessageId: "root", ...change }),
    dm: (id: string, text = id, user = slackA, root?: string) =>
      chat.emitMessage({ ...digit(text, id, user, root), chatMessageId: id }),
    read,
    ack,
    unbound,
    expectItems: (
      sessionId: string,
      items: readonly unknown[],
      person: Person = a,
    ) => expect(read(sessionId, person).items).toMatchObject(items),
    wait: (
      sessionId: string,
      timeoutMs = 1_000,
      signal = new AbortController().signal,
      person: Person = a,
    ) => core.wait(caller(person), { sessionId, timeoutMs }, signal),
    sql,
    rows,
    writes,
    col: (from: string, column: string, ...args: SqlValue[]) =>
      rows(from, column, ...args).map((row) => row[column]),
    posts: () => writes("postText").map((call) => call.args[1]),
  };
}

export type BaseFixture = Awaited<ReturnType<typeof baseFixture>>;

export function seedThread(
  f: BaseFixture,
  id: string,
  text: string,
  kind: "person" | "agent" | "system",
  personId?: string,
  sessionId?: string,
) {
  const insert = f.db.prepare(`INSERT INTO thread_messages
    (adapter,chat_thread_id,channel_id,project_id,chat_message_id,kind,person_id,session_id,text,created_at)
    VALUES ('slack',?,?,?,?,?,?,?,?,?)`);
  const ref = [thread, channel, p1, id, kind];
  insert.run(...ref, personId ?? null, sessionId ?? null, text, f.now());
}
