import type { AskChoice, AskKind, Summary } from "./domain.ts";

export type ChatAdapter = "slack" | "telegram";

export interface ChatCapabilities {
  readonly buttons: boolean;
  readonly editMessage: boolean;
  readonly ephemeral: boolean;
  readonly reactions: boolean;
  readonly threads: boolean;
  readonly longAnswers: boolean;
  readonly mode: "webhook" | "socket" | "polling";
}

export interface ChatMessageRef {
  readonly chatThreadId: string;
  readonly chatMessageId: string;
  readonly channelId: string;
}

export type AskCardState =
  | { readonly kind: "open"; readonly digitFallback: boolean }
  | {
      readonly kind: "answered";
      readonly answeredByName: string;
      readonly choiceLabel: string;
      readonly answeredAt: string;
    }
  | { readonly kind: "expired" };

export interface AskCardView {
  readonly askId: string;
  readonly kind: AskKind;
  readonly projectName: string;
  readonly askedForName: string;
  readonly requesterName?: string;
  readonly issueId?: string;
  readonly question: string;
  readonly choices: readonly AskChoice[];
  readonly state: AskCardState;
}

export interface ChatIdentity {
  readonly adapter: ChatAdapter;
  readonly userId: string;
}

export interface ChatActionEvent {
  readonly eventKey: string;
  readonly slackUserId: string;
  readonly chatIdentity?: ChatIdentity;
  readonly actionId: string;
  readonly value: string;
  readonly message: ChatMessageRef;
}

export interface ChatActionReply {
  readonly ephemeralText?: string;
}

export interface ChatMessageEvent {
  readonly eventKey: string;
  readonly slackUserId: string;
  readonly chatIdentity?: ChatIdentity;
  readonly userName: string;
  readonly isBot: boolean;
  readonly text: string;
  readonly channelId: string;
  readonly chatThreadId: string;
  readonly chatMessageId: string;
  readonly threadRootMessageId?: string;
  readonly isDirect: boolean;
  readonly mentionsBot: boolean;
  readonly mentionedSlackUserIds: readonly string[];
  readonly fileNames: readonly string[];
}

export interface ChatMessageChangeEvent {
  readonly kind: "edited" | "deleted";
  readonly channelId: string;
  readonly chatThreadId: string;
  readonly chatMessageId: string;
  readonly text: string;
  readonly fileNames: readonly string[];
}

export interface ChatInboundHandlers {
  onAction(event: ChatActionEvent): Promise<ChatActionReply>;
  onMessage(event: ChatMessageEvent): Promise<void>;
  onMessageChange(event: ChatMessageChangeEvent): Promise<void>;
}

export type ChatPostTarget =
  | { readonly kind: "thread"; readonly chatThreadId: string }
  | { readonly kind: "channel"; readonly channelId: string };

export type SummaryLookup =
  | { readonly kind: "found"; readonly ref: ChatMessageRef }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

export interface ChatWriteDeadline {
  readonly expiresAt: () => number | undefined;
  readonly now: () => number;
}

export type ChatFailureReason =
  | "not_in_channel"
  | "channel_not_found"
  | "is_archived"
  | "restricted_action"
  | "canvas_unavailable";

export interface ChatPostOptions {
  readonly agentLabel?: string;
}

export interface ChatProbe {
  readonly teamId: string;
  readonly channels: readonly {
    readonly channelId: string;
    readonly botIsMember: boolean;
  }[];
}

export interface ChatPort {
  readonly capabilities: ChatCapabilities;
  start(handlers: ChatInboundHandlers): Promise<void>;
  stop(): Promise<void>;
  handleWebhook(request: Request): Promise<Response>;
  postAskDm(userId: string, card: AskCardView): Promise<ChatMessageRef>;
  editAskDm(ref: ChatMessageRef, card: AskCardView): Promise<void>;
  postText(
    target: ChatPostTarget,
    text: string,
    options?: ChatPostOptions,
  ): Promise<ChatMessageRef>;
  postEphemeral(
    ref: ChatMessageRef,
    userId: string,
    text: string,
  ): Promise<void>;
  postSummary(
    channelId: string,
    summary: Summary,
    publicationKey: string,
  ): Promise<ChatMessageRef>;
  findSummary(
    channelId: string,
    publicationKey: string,
  ): Promise<SummaryLookup>;
  editSummary(
    ref: ChatMessageRef,
    summary: Summary,
    deadline?: ChatWriteDeadline,
  ): Promise<"edited" | "missing" | "abandoned">;
  react(ref: ChatMessageRef, emoji: string): Promise<void>;
  createLongAnswer(
    channelId: string,
    title: string,
    markdown: string,
  ): Promise<string>;
  probe(channelIds: readonly string[]): Promise<ChatProbe>;
}

export const ASK_ACTION_PREFIX = "forge_ask_";
export const SLACK_WEBHOOK_PATH = "/webhooks/slack";
export const SLACK_API_URL = "https://slack.com/api/";
export const SLACK_SOCKET_TOKEN_HEADER = "x-slack-socket-token";
export const SUMMARY_KEY_MARKER = "forge-summary:";
export const SUMMARY_LOOKUP_LIMIT = 100;
export const SUMMARY_LOOKUP_MAX_PAGES = 20;

export class ChatWriteFailure extends Error {
  readonly effect: "refused" | "unknown";
  declare readonly retryAfterMs?: number;
  declare readonly reason?: ChatFailureReason;
  constructor(
    effect: "refused" | "unknown",
    retryAfterMs?: number,
    reason?: ChatFailureReason,
  ) {
    super("CHAT_UNAVAILABLE");
    this.effect = effect;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (reason !== undefined) this.reason = reason;
  }
}
