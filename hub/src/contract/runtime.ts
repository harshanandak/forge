import type { ChatAdapter, ChatMessageRef, ChatPort } from "./chat.ts";
import type { HubCore } from "./core.ts";
import type { PeopleDirectory, TrackerReader } from "./domain.ts";
import type { DoorbellPort } from "./hooks.ts";

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface HubStatement {
  run(...params: SqlValue[]): {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface WorkerClaim {
  release(): void;
}

export interface HubDb {
  exec(sql: string): void;
  prepare(sql: string): HubStatement;
  transaction<T>(work: () => T): T;
  claimWorker(): WorkerClaim;
  close(): void;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface HubLog {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface PersonConfig {
  readonly personId: string;
  readonly displayName: string;
  readonly slackUserId?: string;
  readonly telegramUserId?: string;
}

export interface ProjectConfig {
  readonly projectId: string;
  readonly name: string;
  readonly purpose?: string;
  readonly slackChannelId?: string;
  readonly telegramChatId?: string;
  readonly summaryChannelId?: string;
  readonly summaryMessage?: ChatMessageRef;
  readonly frontPersonId: string;
  readonly memberIds: readonly string[];
}

export interface DoorbellConfig {
  readonly personId: string;
  readonly projectId: string;
  readonly frontThreadId: string;
  readonly urlEnv: string;
  readonly secretEnv: string;
}

export type SlackMode = "off" | "socket" | "webhook";

export interface HubConfig {
  readonly listen: { readonly host: string; readonly port: number };
  readonly publicBaseUrl?: string;
  readonly basePath: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly dataDir: string;
  readonly chat?: { readonly adapter: ChatAdapter | "off" };
  readonly slack: {
    readonly mode: SlackMode;
    readonly buttons: boolean;
    readonly teamId?: string;
  };
  readonly mcp: { readonly enabled: boolean };
  readonly hooks: { readonly enabled: boolean };
  readonly cli: { readonly enabled: boolean };
  readonly people: readonly PersonConfig[];
  readonly projects: readonly ProjectConfig[];
  readonly doorbells: readonly DoorbellConfig[];
}

export class HubConfigError extends Error {
  readonly pointer: string;
  readonly otherPointer?: string;
  constructor(pointer: string, rule: string, otherPointer?: string) {
    super(rule);
    this.pointer = pointer;
    if (otherPointer !== undefined) this.otherPointer = otherPointer;
  }
}

export type SecretName =
  | "SLACK_BOT_TOKEN"
  | "SLACK_SIGNING_SECRET"
  | "SLACK_APP_TOKEN"
  | "TELEGRAM_BOT_TOKEN"
  | `FORGE_DOORBELL_${string}`;

export type ReadSecret = (name: SecretName) => string | undefined;

export interface ChatDeps {
  readonly config: HubConfig;
  readonly secret: ReadSecret;
  readonly people: PeopleDirectory;
  readonly db: HubDb;
  readonly log: HubLog;
  readonly slackApiUrl: string;
}

export interface CoreDeps {
  readonly config: HubConfig;
  readonly db: HubDb;
  readonly chat?: ChatPort;
  readonly people: PeopleDirectory;
  readonly doorbell: DoorbellPort;
  readonly tracker: TrackerReader;
  readonly now: () => number;
  readonly log: HubLog;
}

export interface RemoteDeps {
  readonly config: HubConfig;
  readonly core: HubCore;
  readonly log: HubLog;
}

export interface DoorbellDeps {
  readonly config: HubConfig;
  readonly secret: ReadSecret;
  readonly log: HubLog;
}

export type CreatePeopleDirectory = (
  people: readonly PersonConfig[],
) => PeopleDirectory;
export type CreateChatPort = (deps: ChatDeps) => ChatPort;
export type OpenHubDb = (path: string) => HubDb;
export type CreateHubCore = (deps: CoreDeps) => HubCore;
export interface RemoteHandler {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export type CreateRemoteHandler = (deps: RemoteDeps) => RemoteHandler;
export type CreateDoorbell = (deps: DoorbellDeps) => DoorbellPort;
export type HashSecret = (secret: string) => string;
export type ProtectPath = (path: string, kind: "dir" | "file") => boolean;

export interface AdminDeps {
  readonly config: HubConfig;
  readonly core: HubCore;
  readonly protectPath: ProtectPath;
  readonly readStdin: () => Promise<string>;
}
export type RunAdminCommand = (
  argv: readonly string[],
  deps: AdminDeps,
) => Promise<number>;

export interface DoctorCheck {
  readonly check: string;
  readonly status: "ok" | "action" | "skipped";
  readonly detail: string;
}

export interface SetupDeps {
  readonly loadConfig: (path: string) => HubConfig;
  readonly inspectStorage: (config: HubConfig) => readonly DoctorCheck[];
  readonly protectPath: ProtectPath;
  readonly chat?: ChatPort;
}
export type RunSetupCommand = (
  argv: readonly string[],
  deps: SetupDeps,
) => Promise<number>;
