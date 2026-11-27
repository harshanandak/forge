import type {
  AskCardView,
  ChatActionEvent,
  ChatMessageEvent,
} from "../../src/contract/chat.ts";
import { ASK_ACTION_PREFIX } from "../../src/contract/chat.ts";
import type { AskInput } from "../../src/contract/mcp.ts";
import type { HubConfig, HubDb } from "../../src/contract/runtime.ts";
import { createCoreStore } from "../../src/core/store-impl.ts";
import type { CoreStore } from "../../src/core/store.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import {
  a,
  b,
  caller,
  configPeople,
  fixture,
  p1,
  seedHost,
  value,
} from "./fixture.ts";

export const slackA = "U00000001";
export const slackB = "U00000002";
export const refA = { personId: a.personId, name: a.displayName };
export const refB = { personId: b.personId, name: b.displayName };
export const host = { person: a, hostInstanceId: "hst_a" };
export const question = "Which option is right for this fixture?";
export const choices = [
  { id: "first", label: "Choose the first option" },
  { id: "second", label: "Choose the second option" },
  { id: "third", label: "Choose the third option" },
] as const;

export function bind(db: HubDb, store: CoreStore) {
  seedHost(db);
  return value(
    store.sessions.hookSession(host, {
      host: "claude",
      hostSessionId: "bound-fixture",
      source: "startup",
    }),
  ).sessionId;
}

export function asksOf(store: CoreStore) {
  if (!store.asks) throw new Error("The test needs a chat-enabled ask store");
  return store.asks;
}

export async function askFixture(
  chat = new FakeChatPort(),
  change: Partial<HubConfig> = {},
) {
  const f = await fixture(change);
  let time = f.now();
  const deps = {
    ...f,
    now: () => time,
    people: configPeople(f.config.people),
    chat,
  };
  const store = createCoreStore(deps);
  store.syncDirectory();
  const sessionId = bind(f.db, store);
  const asks = asksOf(store);
  const shared = { sessionId, projectId: p1, question };
  const choice = (input: Partial<AskInput> = {}) =>
    asks.ask(caller, {
      ...shared,
      kind: "choice",
      requestedAction: "choice",
      to: [a.personId, b.personId],
      choices,
      ...input,
    });
  const request = (input: Partial<AskInput> = {}, includeIssue = true) =>
    asks.ask(caller, {
      ...shared,
      kind: "work_request",
      requestedAction: "work",
      ...(includeIssue ? { issueId: "demo-12" } : {}),
      ...input,
    });
  return {
    ...f,
    chat,
    deps,
    store,
    asks,
    choice,
    request,
    sessionId,
    setTime: (at: number) => {
      time = at;
    },
  };
}

export function button(
  askId: string,
  eventKey: string,
  slackUserId = slackA,
  choice = "first",
): ChatActionEvent {
  return {
    eventKey,
    slackUserId,
    actionId: ASK_ACTION_PREFIX + choice,
    value: askId,
    message: {
      channelId: "dm-" + slackUserId,
      chatThreadId: "dm-" + slackUserId,
      chatMessageId: "message-1",
    },
  };
}

export function digit(
  text: string,
  eventKey = text,
  slackUserId = slackA,
  root?: string,
): ChatMessageEvent {
  return {
    ...button("", eventKey, slackUserId).message,
    eventKey,
    slackUserId,
    text,
    userName: "Untrusted fixture name",
    isBot: false,
    isDirect: true,
    mentionsBot: false,
    mentionedSlackUserIds: [],
    fileNames: [],
    ...(root === undefined ? {} : { threadRootMessageId: root }),
  };
}

export function rows(
  db: HubDb,
  table:
    | "asks"
    | "ask_answers"
    | "answer_attempts"
    | "ask_edit_effects"
    | "ask_deliveries"
    | "permits",
) {
  return db.prepare("SELECT * FROM " + table).all();
}

export function scriptedChat(
  effects: ReadonlyMap<string, NonNullable<FakeChatPort["nextWrite"]>>,
  posted?: (person: string, askId: string) => void,
): FakeChatPort {
  const chat = new FakeChatPort();
  const post = chat.postAskDm.bind(chat);
  chat.postAskDm = (slackUserId: string, card: AskCardView) => {
    chat.nextWrite = effects.get(slackUserId);
    const result = post(slackUserId, card);
    posted?.(slackUserId, card.askId);
    return result;
  };
  return chat;
}
