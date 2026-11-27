import type { ChatInboundHandlers } from "./chat.ts";
import type { HubError } from "./errors.ts";
import type {
  HookModeInput,
  HookModeOutput,
  HookSessionInput,
  HookSessionOutput,
  HookStopInput,
  HookStopOutput,
} from "./hooks.ts";
import type {
  AskInput,
  AskOutput,
  HelloInput,
  HelloOutput,
  InboxInput,
  InboxOutput,
  ReplyInput,
  ReplyOutput,
  ReportInput,
  ReportOutput,
  SendInput,
  SendOutput,
  WaitInput,
  WaitOutput,
  InboxItemView,
} from "./mcp.ts";
import type { Person } from "./domain.ts";

export type HubResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HubError };

export interface Caller {
  readonly person: Person;
  readonly tokenId: string;
}

export interface HostCaller {
  readonly person: Person;
  readonly hostInstanceId: string;
}

export interface TokenRecord {
  readonly tokenId: string;
  readonly personId: string;
  readonly label: string;
  readonly tokenHash: string;
}

export interface HostKeyRecord {
  readonly hostInstanceId: string;
  readonly personId: string;
  readonly label: string;
  readonly keyHash: string;
}

export interface CliInboxInput {
  readonly projectId: string;
  readonly sessionId?: string;
  readonly limit?: number;
  readonly ackItemIds?: readonly string[];
}

export interface CliInboxOutput {
  readonly sessionId: string;
  readonly created: boolean;
  readonly items: readonly InboxItemView[];
  readonly more: boolean;
}

export interface CliSendInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly toPersonId: string;
  readonly targetSessionId?: string;
  readonly text: string;
}

export interface HubCore {
  readonly chatHandlers: ChatInboundHandlers;
  start(): Promise<void>;
  findToken(tokenHash: string): TokenRecord | undefined;
  createToken(
    personId: string,
    label: string,
    tokenHash: string,
  ): TokenRecord | undefined;
  revokeToken(tokenId: string): boolean;
  findHostKey(keyHash: string): HostKeyRecord | undefined;
  createHostKey(
    personId: string,
    label: string,
    keyHash: string,
  ): HostKeyRecord | undefined;
  revokeHostKey(hostInstanceId: string): boolean;
  person(personId: string): Person | undefined;
  hello(caller: Caller, input: HelloInput): HubResult<HelloOutput>;
  inbox(caller: Caller, input: InboxInput): HubResult<InboxOutput>;
  wait(
    caller: Caller,
    input: WaitInput,
    signal: AbortSignal,
  ): Promise<HubResult<WaitOutput>>;
  reply(caller: Caller, input: ReplyInput): Promise<HubResult<ReplyOutput>>;
  ask(caller: Caller, input: AskInput): Promise<HubResult<AskOutput>>;
  report(caller: Caller, input: ReportInput): Promise<HubResult<ReportOutput>>;
  send(caller: Caller, input: SendInput): Promise<HubResult<SendOutput>>;
  hookSession(
    host: HostCaller,
    input: HookSessionInput,
  ): HubResult<HookSessionOutput>;
  hookMode(host: HostCaller, input: HookModeInput): HubResult<HookModeOutput>;
  hookStop(
    host: HostCaller,
    input: HookStopInput,
  ): Promise<HubResult<HookStopOutput>>;
  cliInbox(person: Person, input: CliInboxInput): HubResult<CliInboxOutput>;
  cliSend(person: Person, input: CliSendInput): Promise<HubResult<SendOutput>>;
  close(): Promise<void>;
}
