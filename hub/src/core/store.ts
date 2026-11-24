import type {
  AskCardView,
  ChatActionEvent,
  ChatActionReply,
  ChatMessageEvent,
  ChatMessageRef,
  ChatPort,
} from "../contract/chat.ts";
import type {
  Caller,
  HostCaller,
  HostKeyRecord,
  HubResult,
  TokenRecord,
} from "../contract/core.ts";
import type {
  AnswerOutcome,
  HostKind,
  InboxItem,
  PeopleDirectory,
  Permit,
  Person,
  Session,
} from "../contract/domain.ts";
import type { HubError, HubErrorCode } from "../contract/errors.ts";
import type {
  HookModeInput,
  HookModeOutput,
  HookSessionInput,
  HookSessionOutput,
} from "../contract/hooks.ts";
import type { ID_PREFIX } from "../contract/ids.ts";
import type {
  AskAnswerView,
  AskInput,
  AskOutput,
  HelloInput,
  HelloOutput,
} from "../contract/mcp.ts";
import type { HubConfig, HubDb, HubLog } from "../contract/runtime.ts";

export type Tx = <T>(body: () => T) => T;

export interface StoreDeps {
  readonly db: HubDb;
  readonly config: HubConfig;
  readonly people: PeopleDirectory;
  readonly log: HubLog;
  readonly now: () => number;
  readonly chat?: ChatPort;
}

export interface UnreadCounts {
  readonly unread: number;
  readonly unreadFromOthers: number;
  readonly itemIds: readonly string[];
}

export interface AnswerAfter {
  readonly askId: string;
  readonly projectId: string;
  readonly fromSessionId: string;
  readonly fromPersonId: string;
  readonly queuedEdits: boolean;
}

export interface ActionResult {
  readonly reply: ChatActionReply;
  readonly after?: AnswerAfter;
}

export type DigitResult =
  | { readonly kind: "not_a_digit_reply" }
  | { readonly kind: "instruction"; readonly text: string }
  | {
      readonly kind: "answered";
      readonly outcome: AnswerOutcome;
      readonly ephemeralText?: string;
      readonly after?: AnswerAfter;
    };

export interface AskEditJob {
  readonly askId: string;
  readonly personId: string;
  readonly ref: ChatMessageRef;
  readonly card: AskCardView;
  readonly attempts: number;
}

export interface AnswerRow {
  readonly view: AskAnswerView;
  readonly delivered: boolean;
  readonly acked: boolean;
}

export interface SessionStore {
  hello(caller: Caller, input: HelloInput): HubResult<HelloOutput>;
  hookSession(
    host: HostCaller,
    input: HookSessionInput,
  ): HubResult<HookSessionOutput>;
  hookMode(host: HostCaller, input: HookModeInput): HubResult<HookModeOutput>;
  requireOwnSession(person: Person, sessionId: string): HubResult<Session>;
  createUnboundSession(
    person: Person,
    projectId: string | undefined,
    host: HostKind,
  ): Session;
  session(sessionId: string): Session | undefined;
  sessionsByThread(personId: string, threadId: string): readonly Session[];
  markUntrustedRead(sessionId: string): void;
  requireNormalMode(session: Session): HubError | undefined;
  isMember(projectId: string, personId: string): boolean;
  deliverable(session: Session, limit: number): readonly InboxItem[];
  outstanding(session: Session, limit: number): readonly InboxItem[];
  unreadCounts(session: Session): UnreadCounts;
}

export interface CredentialStore {
  createToken(
    personId: string,
    label: string,
    tokenHash: string,
  ): TokenRecord | undefined;
  revokeToken(tokenId: string): boolean;
  findToken(tokenHash: string): TokenRecord | undefined;
  isTokenCurrent(tokenId: string): boolean;
  createHostKey(
    personId: string,
    label: string,
    keyHash: string,
  ): HostKeyRecord | undefined;
  revokeHostKey(hostInstanceId: string): boolean;
  findHostKey(keyHash: string): HostKeyRecord | undefined;
}

export interface AskStore {
  ask(caller: Caller, input: AskInput): Promise<HubResult<AskOutput>>;
  answerAction(event: ChatActionEvent): ActionResult;
  answerDigit(event: ChatMessageEvent): DigitResult;
  answerRows(sessionId: string, limit: number): readonly AnswerRow[];
  findApprovedPermit(
    personId: string,
    projectId: string,
    requestAskId: string,
  ): Permit | undefined;
  pendingEdits(limit: number): readonly AskEditJob[];
  markEditDone(askId: string, personId: string): void;
  markEditFailed(askId: string, personId: string, nextAttemptAt: number): void;
  sweepExpiry(): number;
  reconcileEdits(): void;
  markInterruptedPostingUnknown(): number;
}

export interface Guards {
  outboundText(text: string, pointer: string): HubError | undefined;
  storedText(text: string): string;
  fail(code: HubErrorCode, pointer?: string): HubError;
}

export interface CoreStore {
  readonly tx: Tx;
  readonly sessions: SessionStore;
  readonly credentials: CredentialStore;
  readonly asks?: AskStore;
  readonly guards: Guards;
  newId(kind: keyof typeof ID_PREFIX): string;
  syncDirectory(): void;
}

export type CreateCoreStore = (deps: StoreDeps) => CoreStore;
export type RefuseNetworkPath = (
  dir: string,
  mounts?: string,
) => string | undefined;
