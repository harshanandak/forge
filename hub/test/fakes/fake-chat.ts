import {
  ChatWriteFailure,
  type AskCardView,
  type ChatActionEvent,
  type ChatActionReply,
  type ChatCapabilities,
  type ChatFailureReason,
  type ChatInboundHandlers,
  type ChatMessageChangeEvent,
  type ChatMessageEvent,
  type ChatMessageRef,
  type ChatPort,
  type ChatPostOptions,
  type ChatPostTarget,
  type ChatProbe,
  type SummaryLookup,
} from "../../src/contract/chat.ts";
import type { Summary } from "../../src/contract/domain.ts";
import { isTelegramId } from "../../src/core/directory.ts";

type CallName =
  | keyof Omit<ChatPort, "capabilities">
  | "emitAction"
  | "emitMessage"
  | "emitMessageChange";
type Call = { readonly name: CallName; readonly args: readonly unknown[] };
type NextWrite =
  | {
      readonly kind: "refused";
      readonly retryAfterMs?: number;
      readonly reason?: ChatFailureReason;
    }
  | {
      readonly kind: "unknown";
      readonly reason?: ChatFailureReason;
      readonly until?: Promise<void>;
    }
  | { readonly kind: "delay"; readonly until: Promise<void> };
type MessageDetails = Pick<
  ChatMessageEvent,
  "mentionedSlackUserIds" | "fileNames"
>;
type FakeMessage = Omit<ChatMessageEvent, keyof MessageDetails> &
  Partial<MessageDetails> & {
    readonly teamId?: string;
  };

export class FakeChatPort implements ChatPort {
  readonly capabilities: ChatCapabilities;
  readonly calls: Call[] = [];
  readonly writes: Call[] = [];
  readonly askCards: AskCardView[] = [];
  readonly memberships = new Map<string, boolean>();
  readonly teamId: string;
  nextWrite: NextWrite | undefined;

  private inbound: ChatInboundHandlers | undefined;
  private sequence = 0;
  private readonly summaries = new Map<string, ChatMessageRef>();

  constructor(
    teamId = "TTEST000",
    capabilities: Partial<ChatCapabilities> = {},
  ) {
    this.teamId = teamId;
    this.capabilities = {
      buttons: true,
      editMessage: true,
      ephemeral: true,
      reactions: true,
      threads: true,
      longAnswers: true,
      mode: "socket",
      ...capabilities,
    };
  }

  private record(name: CallName, ...args: unknown[]): Call {
    const call = { name, args };
    this.calls.push(call);
    return call;
  }

  private handlers(): ChatInboundHandlers {
    if (!this.inbound) throw new Error("fake chat is stopped");
    return this.inbound;
  }

  private async write<T>(
    name: CallName,
    args: unknown[],
    apply: () => T,
  ): Promise<T> {
    const call = this.record(name, ...args);
    const outcome = this.nextWrite;
    this.nextWrite = undefined;
    if (outcome?.kind === "refused")
      throw new ChatWriteFailure(
        "refused",
        outcome.retryAfterMs,
        outcome.reason,
      );
    const value = apply();
    this.writes.push(call);
    if (outcome?.kind === "unknown") {
      if (outcome.until) await outcome.until;
      throw new ChatWriteFailure("unknown", undefined, outcome.reason);
    }
    if (outcome?.kind === "delay") await outcome.until;
    return value;
  }

  private ref(channelId: string, chatThreadId = channelId): ChatMessageRef {
    this.sequence += 1;
    return {
      channelId,
      chatThreadId,
      chatMessageId: "message-" + this.sequence,
    };
  }

  start(handlers: ChatInboundHandlers): Promise<void> {
    this.record("start", handlers);
    this.inbound = handlers;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.record("stop");
    this.inbound = undefined;
    return Promise.resolve();
  }

  handleWebhook(request: Request): Promise<Response> {
    this.record("handleWebhook", request);
    return Promise.resolve(new Response(null, { status: 405 }));
  }

  emitAction(event: ChatActionEvent): Promise<ChatActionReply> {
    this.record("emitAction", event);
    return this.handlers().onAction(event);
  }

  emitMessage(event: FakeMessage): Promise<void> {
    this.record("emitMessage", event);
    const {
      teamId,
      mentionedSlackUserIds = [],
      fileNames = [],
      ...message
    } = event;
    if (teamId !== undefined && teamId !== this.teamId)
      return Promise.resolve();
    return this.handlers().onMessage({
      ...message,
      mentionedSlackUserIds,
      fileNames,
    });
  }

  emitMessageChange(event: ChatMessageChangeEvent): Promise<void> {
    this.record("emitMessageChange", event);
    return this.handlers().onMessageChange(event);
  }

  postAskDm(userId: string, card: AskCardView): Promise<ChatMessageRef> {
    this.askCards.push(card);
    const slackChannelId = "dm-" + userId;
    const channelId = isTelegramId(userId) ? userId : slackChannelId;
    return this.write("postAskDm", [userId, card], () => this.ref(channelId));
  }

  editAskDm(ref: ChatMessageRef, card: AskCardView): Promise<void> {
    this.askCards.push(card);
    return this.write("editAskDm", [ref, card], () => undefined);
  }

  postText(
    target: ChatPostTarget,
    text: string,
    options?: ChatPostOptions,
  ): Promise<ChatMessageRef> {
    return this.write("postText", [target, text, options], () =>
      this.ref(
        target.kind === "channel" ? target.channelId : target.chatThreadId,
      ),
    );
  }

  postEphemeral(
    ref: ChatMessageRef,
    slackUserId: string,
    text: string,
  ): Promise<void> {
    return this.write(
      "postEphemeral",
      [ref, slackUserId, text],
      () => undefined,
    );
  }

  provisionSummary(
    channelId: string,
    publicationKey: string,
    ref: ChatMessageRef,
  ): void {
    this.summaries.set(JSON.stringify([channelId, publicationKey]), ref);
  }

  postSummary(
    channelId: string,
    summary: Summary,
    publicationKey: string,
  ): Promise<ChatMessageRef> {
    return this.write(
      "postSummary",
      [channelId, summary, publicationKey],
      () => {
        const ref = this.ref(channelId);
        this.provisionSummary(channelId, publicationKey, ref);
        return ref;
      },
    );
  }

  findSummary(
    channelId: string,
    publicationKey: string,
  ): Promise<SummaryLookup> {
    this.record("findSummary", channelId, publicationKey);
    const ref = this.summaries.get(JSON.stringify([channelId, publicationKey]));
    return Promise.resolve(ref ? { kind: "found", ref } : { kind: "unknown" });
  }

  editSummary(
    ref: ChatMessageRef,
    summary: Summary,
  ): Promise<"edited" | "missing"> {
    const found = [...this.summaries.values()].some(
      (row) =>
        row.channelId === ref.channelId &&
        row.chatMessageId === ref.chatMessageId &&
        row.chatThreadId === ref.chatThreadId,
    );
    if (found) return this.write("editSummary", [ref, summary], () => "edited");
    this.record("editSummary", ref, summary);
    return Promise.resolve("missing");
  }

  react(ref: ChatMessageRef, emoji: string): Promise<void> {
    return this.write("react", [ref, emoji], () => undefined);
  }

  createLongAnswer(
    channelId: string,
    title: string,
    markdown: string,
  ): Promise<string> {
    if (!this.capabilities.longAnswers) {
      this.record("createLongAnswer", channelId, title, markdown);
      return Promise.reject(
        new ChatWriteFailure("refused", undefined, "canvas_unavailable"),
      );
    }
    return this.write(
      "createLongAnswer",
      [channelId, title, markdown],
      () => "https://example.test/canvas/" + this.ref(channelId).chatMessageId,
    );
  }

  probe(channelIds: readonly string[]): Promise<ChatProbe> {
    this.record("probe", channelIds);
    const channels = channelIds.map((channelId) => ({
      channelId,
      botIsMember: this.memberships.get(channelId) ?? false,
    }));
    return Promise.resolve({ teamId: this.teamId, channels });
  }
}
