import { cardToBlockKit, cardToFallbackText } from "@chat-adapter/slack";
import { Chat, type CardElement } from "chat";
import {
  ChatWriteFailure,
  SLACK_SOCKET_TOKEN_HEADER,
  SUMMARY_KEY_MARKER,
  type AskCardView,
  type ChatMessageRef,
  type ChatInboundHandlers,
} from "../contract/chat.ts";
import type { CreateChatPort } from "../contract/runtime.ts";
import { createLongAnswer } from "./canvas.ts";
import { renderAskCard, renderSummaryCard, renderTextCard } from "./cards.ts";
import { chatConfig, slackAdapterConfig, slackWorkspace } from "./config.ts";
import { slackPlatformCode, toChatWriteFailure } from "./failure.ts";
import {
  channelId,
  messageRef,
  parseMessageRef,
  PinnedSlackAdapter,
  registerInboundHandlers,
  timestamp,
} from "./inbound.ts";
import { probeSlack, record } from "./probe.ts";
import { createChatLogger } from "./logger.ts";
import { findSummary, readSummaryKey } from "./summary.ts";

function invalidBlocksCause(error: unknown): unknown {
  const cause = record(error)?.cause;
  return slackPlatformCode(cause) === "invalid_blocks" ? cause : error;
}

async function slackOperation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toChatWriteFailure(invalidBlocksCause(error));
  }
}

function postedRef(
  channel: string,
  ts: unknown,
  root?: string,
): ChatMessageRef {
  if (!timestamp(ts)) throw new ChatWriteFailure("unknown");
  return messageRef(channel, ts, root);
}

function labelForSlack(label: string): string {
  const display = label.replace(/[\p{Cc}\p{Zl}\p{Zp}<>]/gu, "");
  return [...display].slice(0, 80).join("") || "Forge";
}

export const createSlackChatPort: CreateChatPort = (deps) => {
  const logger = createChatLogger(deps.log);
  const pending = new Set<Promise<void>>();
  function track(work: Promise<unknown>): Promise<void> {
    const task = work.then(
      () => undefined,
      () => logger.error("chat.error", { count: 1 }),
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  }

  const adapter = new PinnedSlackAdapter(
    slackAdapterConfig(deps),
    slackWorkspace(deps),
    track,
  );
  const chat = new Chat(chatConfig(adapter, deps));
  const mode = adapter.isSocketMode ? "socket" : "webhook";
  let buttons = deps.config.slack.buttons;
  let active = false;
  let handlers: ChatInboundHandlers | undefined;
  let lifecycle = Promise.resolve();
  function schedule(work: () => Promise<void>): Promise<void> {
    const next = lifecycle.then(() => slackOperation(work));
    lifecycle = next.catch(() => undefined);
    return next;
  }

  function prepareAsk(view: AskCardView): AskCardView {
    if (view.state.kind === "open" && !buttons)
      return { ...view, state: { kind: "open", digitFallback: true } };
    return view;
  }

  async function post(
    channel: string,
    card: CardElement,
  ): Promise<ChatMessageRef> {
    if (!channelId(channel)) throw new ChatWriteFailure("refused");
    const result = await adapter.postChannelMessage("slack:" + channel, card);
    return postedRef(channel, result.id);
  }

  function validateRef(ref: ChatMessageRef): void {
    const parsed = parseMessageRef(ref.chatThreadId, ref.chatMessageId);
    if (parsed?.channelId !== ref.channelId)
      throw new ChatWriteFailure("refused");
  }

  registerInboundHandlers(chat, adapter, {
    onAction: (event) => handlers?.onAction(event) ?? Promise.resolve({}),
    onMessage: (event) => handlers?.onMessage(event) ?? Promise.resolve(),
    onMessageChange: (event) =>
      handlers?.onMessageChange(event) ?? Promise.resolve(),
  });

  return {
    capabilities: {
      get buttons() {
        return buttons;
      },
      mode,
      editMessage: true,
      ephemeral: true,
      reactions: true,
      threads: true,
      longAnswers: false,
    },
    start(nextHandlers) {
      return schedule(async () => {
        if (active) return;
        await adapter.identify();
        handlers = nextHandlers;
        try {
          await chat.initialize();
          active = true;
        } catch (error) {
          handlers = undefined;
          await chat.shutdown();
          throw error;
        }
      });
    },
    stop() {
      return schedule(async () => {
        if (!active) return;
        active = false;
        try {
          await chat.shutdown();
          while (pending.size > 0) await Promise.all(pending);
        } finally {
          handlers = undefined;
        }
      });
    },
    handleWebhook(request) {
      if (request.headers.has(SLACK_SOCKET_TOKEN_HEADER))
        return Promise.resolve(new Response(null, { status: 401 }));
      if (mode === "socket")
        return Promise.resolve(new Response(null, { status: 404 }));
      if (!active) return Promise.resolve(new Response(null, { status: 503 }));
      const response = chat.webhooks.slack(request, {
        waitUntil: (task) => void track(task),
      });
      void track(response);
      return response;
    },
    postAskDm(slackUserId, view) {
      return slackOperation(async () => {
        const dm = adapter.decodeThreadId(await adapter.openDM(slackUserId));
        const card = prepareAsk(view);
        try {
          return await post(dm.channel, renderAskCard(card));
        } catch (error) {
          if (
            card.state.kind !== "open" ||
            card.state.digitFallback ||
            slackPlatformCode(invalidBlocksCause(error)) !== "invalid_blocks"
          )
            throw error;
          buttons = false;
          logger.warn("chat.warn", { count: 1 });
          return post(dm.channel, renderAskCard(prepareAsk(view)));
        }
      });
    },
    editAskDm(ref, view) {
      return slackOperation(async () => {
        validateRef(ref);
        await adapter.editMessage(
          ref.chatThreadId,
          ref.chatMessageId,
          renderAskCard(prepareAsk(view)),
        );
      });
    },
    postText(target, text, options) {
      return slackOperation(async () => {
        if (text.includes(SUMMARY_KEY_MARKER))
          throw new ChatWriteFailure("refused");
        const threadId =
          target.kind === "thread"
            ? target.chatThreadId
            : "slack:" + target.channelId + ":";
        const { channel, threadTs } = adapter.decodeThreadId(threadId);
        if (
          !channelId(channel) ||
          (target.kind === "thread" && !timestamp(threadTs))
        )
          throw new ChatWriteFailure("refused");
        const root = threadTs || undefined;
        const card = renderTextCard(text);
        let ref: ChatMessageRef;
        if (options?.agentLabel !== undefined) {
          const result: unknown = await adapter.webClient.chat.postMessage({
            channel,
            ...(root ? { thread_ts: root } : {}),
            text: cardToFallbackText(card),
            blocks: cardToBlockKit(card),
            username: labelForSlack(options.agentLabel),
            as_user: false,
            unfurl_links: false,
            unfurl_media: false,
          });
          const posted = record(result);
          if (posted?.ok !== true || posted.channel !== channel)
            throw new ChatWriteFailure("unknown");
          ref = postedRef(channel, posted.ts, root);
        } else {
          const result = await adapter.postMessage(threadId, card);
          ref = postedRef(channel, result.id, root);
        }
        if (target.kind === "channel")
          await chat.getState().subscribe(ref.chatThreadId);
        return ref;
      });
    },
    postEphemeral(ref, slackUserId, text) {
      return slackOperation(async () => {
        validateRef(ref);
        await adapter.postEphemeral(
          ref.chatThreadId,
          slackUserId,
          renderTextCard(text),
        );
      });
    },
    postSummary(channel, summary, publicationKey) {
      return slackOperation(() =>
        post(channel, renderSummaryCard(summary, publicationKey)),
      );
    },
    findSummary(channel, publicationKey) {
      return findSummary(adapter, channel, publicationKey);
    },
    async editSummary(ref, summary, deadline) {
      try {
        validateRef(ref);
        const publicationKey = await readSummaryKey(adapter, ref);
        if (deadline) {
          const expiresAt = deadline.expiresAt();
          if (expiresAt !== undefined && deadline.now() >= expiresAt)
            return "abandoned";
        }
        await adapter.editMessage(
          ref.chatThreadId,
          ref.chatMessageId,
          renderSummaryCard(summary, publicationKey),
        );
        return "edited";
      } catch (error) {
        if (slackPlatformCode(error) === "message_not_found") return "missing";
        throw toChatWriteFailure(invalidBlocksCause(error));
      }
    },
    react(ref, name) {
      return slackOperation(async () => {
        validateRef(ref);
        if (!/^[a-z0-9_+-]{1,50}$/.test(name))
          throw new ChatWriteFailure("refused");
        try {
          const { channelId: channel, chatMessageId: timestamp } = ref;
          await adapter.webClient.reactions.add({ channel, timestamp, name });
        } catch (error) {
          if (slackPlatformCode(error) !== "already_reacted") throw error;
        }
      });
    },
    createLongAnswer,
    probe: (channels) => probeSlack(adapter, channels),
  };
};
