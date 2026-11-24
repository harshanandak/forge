import { SlackAdapter, type SlackAdapterConfig } from "@chat-adapter/slack";
import type { Chat, Message, Thread } from "chat";
import {
  ASK_ACTION_PREFIX,
  ChatWriteFailure,
  type ChatInboundHandlers,
  type ChatMessageRef,
} from "../contract/chat.ts";
import { renderTextCard } from "./cards.ts";
import { list, readSlackIdentity, record, string } from "./probe.ts";

type Track = (task: Promise<unknown>) => Promise<void>;
type EventDelivery = Parameters<SlackAdapter["isDuplicateEventDelivery"]>;
type InteractiveDelivery = Parameters<SlackAdapter["handleInteractivePayload"]>;
type SocketDelivery = Parameters<SlackAdapter["routeSocketEvent"]>;

export function channelId(value: unknown): value is string {
  return typeof value === "string" && /^[CDG][A-Z0-9]+$/.test(value);
}

export function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d{6}$/.test(value);
}

export function messageRef(
  channel: string,
  ts: string,
  root = ts,
): ChatMessageRef {
  return {
    channelId: channel,
    chatMessageId: ts,
    chatThreadId: "slack:" + channel + ":" + root,
  };
}

export function parseMessageRef(
  threadId: string,
  messageId: string,
): ChatMessageRef | undefined {
  const [adapter, channel, root, extra] = threadId.split(":");
  if (
    adapter === "slack" &&
    extra === undefined &&
    channelId(channel) &&
    timestamp(root) &&
    timestamp(messageId)
  )
    return messageRef(channel, messageId, root);
  return undefined;
}

export class PinnedSlackAdapter extends SlackAdapter {
  private appId: string | undefined;
  private readonly workspace: string;
  private readonly track: Track;

  constructor(config: SlackAdapterConfig, workspace: string, track: Track) {
    super(config);
    this.workspace = workspace;
    this.track = track;
  }

  async identify(): Promise<void> {
    const { teamId, userId, botId, appId } = await readSlackIdentity(this);
    if (teamId !== this.workspace || !userId)
      throw new ChatWriteFailure("refused");
    this._botUserId = userId;
    this._botId = botId ?? null;
    this.appId = appId;
  }

  ownsSender(raw: Record<string, unknown>): boolean {
    const profile = record(raw.bot_profile);
    return (
      (this._botUserId !== null &&
        (raw.user === this._botUserId ||
          profile?.user_id === this._botUserId)) ||
      (this._botId !== null && raw.bot_id === this._botId) ||
      (this.appId !== undefined &&
        (raw.app_id === this.appId || profile?.app_id === this.appId))
    );
  }

  private accepts(outer: unknown, inner: unknown): boolean {
    const teams = [outer, inner].filter((team) => team !== undefined);
    if (teams.length > 0 && teams.every((team) => team === this.workspace))
      return true;
    this.logger.warn("chat.warn", { count: 1 });
    return false;
  }

  private acceptsEvent(value: unknown): boolean {
    const event = record(value);
    const authorizations = list(event?.authorizations);
    const first = authorizations?.[0];
    const team =
      first === undefined ? undefined : (record(first)?.team_id ?? null);
    return this.accepts(
      event?.team_id,
      event?.authorizations === undefined || authorizations ? team : null,
    );
  }

  private acceptsAction(value: unknown): boolean {
    const action = record(value);
    return this.accepts(
      action?.team_id,
      action?.team === undefined
        ? undefined
        : (record(action.team)?.id ?? null),
    );
  }

  protected override threadIdForMessageEvent(
    event: Parameters<SlackAdapter["threadIdForMessageEvent"]>[0],
  ): string {
    const { channel = "", thread_ts, ts } = event;
    return this.encodeThreadId({ channel, threadTs: thread_ts || ts || "" });
  }

  protected override isDuplicateEventDelivery(
    ...args: EventDelivery
  ): Promise<boolean> {
    if (args[0].type === "event_callback" && !this.acceptsEvent(args[0]))
      return Promise.resolve(true);
    const event = record(args[0].event);
    if (event && this.ownsSender(event)) return Promise.resolve(true);
    return super.isDuplicateEventDelivery(...args);
  }

  protected override handleInteractivePayload(
    ...args: InteractiveDelivery
  ): Response | Promise<Response> {
    const payload = new URLSearchParams(args[0]).get("payload");
    if (payload) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return super.handleInteractivePayload(...args);
      }
      if (!this.acceptsAction(parsed))
        return new Response(null, { status: 200 });
    }
    return super.handleInteractivePayload(...args);
  }

  protected override routeSocketEvent(
    ...[body, type, ack, options, retry]: SocketDelivery
  ): Promise<void> {
    if (
      (type === "events_api" && !this.acceptsEvent(body)) ||
      (type === "interactive" && !this.acceptsAction(body))
    )
      return this.track(ack());
    return this.track(
      super.routeSocketEvent(
        body,
        type,
        ack,
        { ...options, waitUntil: (task) => void this.track(task) },
        retry,
      ),
    );
  }
}

function fileNames(raw: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const item of list(raw.files) ?? []) {
    const name = string(record(item)?.name);
    if (name) names.push(name);
  }
  return names;
}

export function registerInboundHandlers(
  chat: Chat<{ slack: SlackAdapter }>,
  adapter: PinnedSlackAdapter,
  handlers: ChatInboundHandlers,
): void {
  async function deliver(thread: Thread, message: Message) {
    const raw = record(message.raw);
    const ref = parseMessageRef(thread.id, message.id);
    const userId = string(message.author.userId);
    if (
      !raw ||
      !ref ||
      !userId ||
      message.author.isMe ||
      adapter.ownsSender(raw)
    )
      return;
    const text = typeof raw.text === "string" ? raw.text : "";
    const mentions = new Set<string>();
    for (const match of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)) {
      const id = match[1];
      if (id && id !== adapter.botUserId) mentions.add(id);
    }
    const isDirect = adapter.isDM(thread.id);
    const mentionsBot = message.isMention === true;
    if (isDirect || mentionsBot) await thread.subscribe();
    await handlers.onMessage({
      ...ref,
      eventKey: "slack:" + ref.channelId + ":" + ref.chatMessageId,
      slackUserId: userId,
      userName: message.author.userName,
      isBot:
        message.author.isBot === true ||
        Boolean(string(raw.bot_id) || string(raw.app_id)),
      text,
      isDirect,
      mentionsBot,
      mentionedSlackUserIds: [...mentions],
      fileNames: fileNames(raw),
      ...(timestamp(raw.thread_ts) && raw.thread_ts !== message.id
        ? { threadRootMessageId: raw.thread_ts }
        : {}),
    });
  }

  chat.onDirectMessage(deliver);
  chat.onNewMention(deliver);
  chat.onSubscribedMessage(deliver);

  chat.onAction(
    async ({ actionId, messageId, threadId, user, triggerId, raw, value }) => {
      if (
        typeof actionId !== "string" ||
        !actionId.startsWith(ASK_ACTION_PREFIX) ||
        typeof value !== "string" ||
        !/^[UW][A-Z0-9]+$/.test(user.userId) ||
        user.userId === adapter.botUserId
      )
        return;
      const message = parseMessageRef(threadId, messageId);
      if (!message) return;
      const action = list(record(raw)?.actions)
        ?.map(record)
        .find((entry) => entry?.action_id === actionId);
      const actionTs = string(action?.action_ts);
      const eventKey =
        string(triggerId) ||
        (actionTs
          ? [messageId, actionId, user.userId, actionTs].join(":")
          : undefined);
      if (!eventKey) return;
      const { ephemeralText } = await handlers.onAction({
        eventKey,
        slackUserId: user.userId,
        actionId,
        value,
        message,
      });
      if (ephemeralText)
        await adapter.postEphemeral(
          threadId,
          user.userId,
          renderTextCard(ephemeralText),
        );
    },
  );

  chat.onMessageUpdated(async (thread, message) => {
    const raw = record(message.raw);
    const ref = parseMessageRef(thread.id, message.id);
    if (
      !ref ||
      !raw ||
      message.author.isMe ||
      adapter.ownsSender(raw) ||
      !(await chat.getState().isSubscribed(thread.id))
    )
      return;
    await handlers.onMessageChange({
      ...ref,
      kind: "edited",
      text: typeof raw.text === "string" ? raw.text : "",
      fileNames: fileNames(raw),
    });
  });

  chat.onMessageDeleted(
    async ({ threadId, messageId, raw, previousMessage }) => {
      const event = record(raw);
      const previous =
        record(previousMessage?.raw) ?? record(event?.previous_message);
      const ref = parseMessageRef(threadId, messageId);
      if (
        !ref ||
        previousMessage?.author.isMe ||
        (previous && adapter.ownsSender(previous)) ||
        (event && adapter.ownsSender(event)) ||
        !(await chat.getState().isSubscribed(threadId))
      )
        return;
      await handlers.onMessageChange({
        ...ref,
        kind: "deleted",
        text: "",
        fileNames: [],
      });
    },
  );
}
