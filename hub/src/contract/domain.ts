import type { ChatAdapter, ChatMessageRef } from "./chat.ts";

export type HostKind = "claude" | "codex" | "opencode" | "t3" | "other";
export type HookSessionSource = "startup" | "resume" | "clear" | "compact";
export type SessionMode = "normal" | "reply_only";
export type ModeReason =
  | "start"
  | "unbound_start"
  | "resume_unknown"
  | "read_untrusted"
  | "request_approved";

export interface Person {
  readonly personId: string;
  readonly displayName: string;
  readonly slackUserId?: string;
  readonly telegramUserId?: string;
}

export interface PeopleDirectory {
  all(): readonly Person[];
  byPersonId(personId: string): Person | undefined;
  byChatUserId(adapter: ChatAdapter, userId: string): Person | undefined;
  bySlackUserId(slackUserId: string): Person | undefined;
}

export interface Project {
  readonly projectId: string;
  readonly name: string;
  readonly purpose?: string;
  readonly slackChannelId?: string;
  readonly summaryChannelId?: string;
  readonly summaryMessage?: ChatMessageRef;
  readonly frontPersonId: string;
  readonly memberIds: readonly string[];
}

export interface Session {
  readonly sessionId: string;
  readonly personId: string;
  readonly host: HostKind;
  readonly hostInstanceId?: string;
  readonly hostSessionId?: string;
  readonly startSource?: HookSessionSource;
  readonly threadId?: string;
  readonly parentSessionId?: string;
  readonly projectId?: string;
  readonly mode: SessionMode;
  readonly modeReason: ModeReason;
  readonly modeChangedAt: number;
  readonly untrustedReadSeq: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface Conversation {
  readonly conversationId: string;
  readonly projectId?: string;
  readonly personId: string;
  readonly sessionId?: string;
  readonly adapter: "slack";
  readonly chatThreadId: string;
  readonly channelId: string;
  readonly isDirect: boolean;
  readonly createdBy: "slack" | "agent";
  readonly createdAt: number;
}

export type Sender =
  | {
      readonly kind: "person";
      readonly personId: string;
      readonly displayName: string;
    }
  | {
      readonly kind: "agent";
      readonly personId: string;
      readonly displayName: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: "cli";
      readonly personId: string;
      readonly displayName: string;
      readonly sessionId: string;
    }
  | { readonly kind: "system" };

export type InboxKind =
  "chat_message" | "agent_message" | "cli_message" | "system";

export interface InboxItem {
  readonly itemId: string;
  readonly dedupeKey: string;
  readonly ownerPersonId: string;
  readonly targetSessionId?: string;
  readonly forSubagentSessionId?: string;
  readonly conversationId?: string;
  readonly projectId?: string;
  readonly kind: InboxKind;
  readonly sender: Sender;
  readonly notYourOwner: boolean;
  readonly held: boolean;
  readonly text: string;
  readonly chatMessageId?: string;
  readonly receivedAt: number;
  readonly deliveredAt?: number;
  readonly deliveredToSessionId?: string;
  readonly ackedAt?: number;
}

export type AskKind = "choice" | "work_request";
export type AskStatus = "open" | "answered" | "expired";
export type RequestedAction =
  | "choice"
  | "work"
  | "merge"
  | "deploy"
  | "release"
  | "publish"
  | "force_push"
  | "stop_lift";

export const AUTHORITY_ACTIONS: readonly RequestedAction[] = [
  "merge",
  "deploy",
  "release",
  "publish",
  "force_push",
  "stop_lift",
];

export interface AskChoice {
  readonly id: string;
  readonly label: string;
}

export interface Ask {
  readonly askId: string;
  readonly projectId: string;
  readonly kind: AskKind;
  readonly requestedAction: "choice" | "work";
  readonly fromSessionId: string;
  readonly fromPersonId: string;
  readonly fromSessionUntrustedSeq: number;
  readonly question: string;
  readonly choices: readonly AskChoice[];
  readonly allowedAnswererIds: readonly string[];
  readonly issueId?: string;
  readonly inboxItemId?: string;
  readonly status: AskStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AskAnswer {
  readonly askId: string;
  readonly choiceId: string;
  readonly choiceLabel: string;
  readonly answeredByPersonId: string;
  readonly answeredByName: string;
  readonly answeredAt: number;
  readonly source: "button" | "digit";
}

export type AnswerOutcome =
  | { readonly kind: "locked"; readonly answer: AskAnswer }
  | { readonly kind: "already_answered"; readonly answer: AskAnswer }
  | { readonly kind: "expired" }
  | { readonly kind: "not_allowed" }
  | { readonly kind: "invalid_choice" }
  | { readonly kind: "unknown_ask" }
  | { readonly kind: "unknown_answerer" };

export const WORK_REQUEST_CHOICES: readonly AskChoice[] = [
  { id: "approve", label: "Approve" },
  { id: "decline", label: "Decline" },
  { id: "clarify", label: "Ask what they mean" },
];

export type PermitScope =
  | { readonly kind: "issue"; readonly issueId: string }
  | {
      readonly kind: "request";
      readonly askId: string;
      readonly issueId?: string;
    };

export type PermitEvidence = "clean_bound_session" | "owner_approval";

export interface Permit {
  readonly permitId: string;
  readonly personId: string;
  readonly projectId: string;
  readonly scope: PermitScope;
  readonly source: "owner_session" | "approved_request";
  readonly evidence: PermitEvidence;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export type ReportState = "working" | "blocked" | "done";

export interface SummaryLine {
  readonly personId: string;
  readonly personName: string;
  readonly issueId?: string;
  readonly issueTitle?: string;
  readonly state: ReportState;
  readonly text: string;
  readonly hostLabel: string;
  readonly updatedAt: number;
}

export interface Summary {
  readonly projectId: string;
  readonly projectName: string;
  readonly revision: number;
  readonly lines: readonly SummaryLine[];
  readonly updatedAt: number;
}

export interface TrackerIssue {
  readonly issueId: string;
  readonly title: string;
  readonly status: string;
}

export interface TrackerReader {
  issue(projectId: string, issueId: string): Promise<TrackerIssue | undefined>;
}
