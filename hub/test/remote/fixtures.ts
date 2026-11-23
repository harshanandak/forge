import { createHash } from "node:crypto";
import type {
  Caller,
  CliInboxInput,
  CliInboxOutput,
  CliSendInput,
  HostCaller,
  HostKeyRecord,
  HubCore,
  HubResult,
  TokenRecord,
} from "../../src/contract/core.ts";
import type { HubError, HubErrorCode } from "../../src/contract/errors.ts";
import type {
  HookModeInput,
  HookModeOutput,
  HookSessionInput,
  HookSessionOutput,
  HookStopInput,
  HookStopOutput,
} from "../../src/contract/hooks.ts";
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
} from "../../src/contract/mcp.ts";
import type {
  HubConfig,
  HubLog,
  LogFields,
  RemoteHandler,
} from "../../src/contract/runtime.ts";

export const person = { personId: "per_owner", displayName: "Owner" };
export const token = ["f", "h_", "a".repeat(43)].join("");
export const key = ["fh", "k_", "b".repeat(43)].join("");
export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const ok = <T>(value: T): HubResult<T> => ({ ok: true, value });
export const fail = (
  code: HubErrorCode,
  details: Partial<HubError> = {},
): HubResult<never> => ({
  ok: false,
  error: { message: code, retry: "never", ...details, code },
});
export const inboxResult = {
  items: [],
  answers: [],
  mode: "normal",
  more: false,
} as const;
export const waitResult = {
  status: "pending",
  items: [],
  answers: [],
  mode: "normal",
} as const;

export const helloResult = {
  sessionId: "ses_a",
  person: { personId: person.personId, name: person.displayName },
  bound: true,
  mode: "normal",
  projects: [],
  unread: 0,
  unreadFromOthers: 0,
  rules: [],
} as const;

export function config(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    listen: { host: "127.0.0.1", port: 3775 },
    basePath: "",
    allowedHosts: ["127.0.0.1:3775"],
    allowedOrigins: ["https://hub.example"],
    dataDir: "fixture",
    slack: { mode: "socket", buttons: true },
    mcp: { enabled: true },
    hooks: { enabled: true },
    cli: { enabled: true },
    people: [person],
    projects: [
      {
        projectId: "prj_demo",
        name: "Demo",
        frontPersonId: person.personId,
        memberIds: [person.personId],
      },
    ],
    doorbells: [],
    ...overrides,
  };
}

export class FakeLog implements HubLog {
  readonly fields: Array<[string, string, LogFields | undefined]> = [];
  info(event: string, fields?: LogFields): void {
    this.fields.push(["info", event, fields]);
  }
  warn(event: string, fields?: LogFields): void {
    this.fields.push(["warn", event, fields]);
  }
  error(event: string, fields?: LogFields): void {
    this.fields.push(["error", event, fields]);
  }
}

export class FakeHubCore implements HubCore {
  readonly calls: Array<[string, ...unknown[]]> = [];
  readonly tokens = new Map<string, TokenRecord>();
  readonly keys = new Map<string, HostKeyRecord>();
  readonly chatHandlers: HubCore["chatHandlers"] = {
    onAction: () => Promise.reject(new Error("Unexpected action")),
    onMessage: () => Promise.resolve(),
    onMessageChange: () => Promise.resolve(),
  };

  readonly settings;

  constructor(settings = config()) {
    this.settings = settings;
    this.tokens.set(digest(token), {
      tokenId: "tok_a",
      label: "test",
      personId: person.personId,
      tokenHash: digest(token),
    });
    this.keys.set(digest(key), {
      hostInstanceId: "hst_a",
      label: "test",
      personId: person.personId,
      keyHash: digest(key),
    });
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  findToken(hash: string): TokenRecord | undefined {
    this.calls.push(["findToken", hash]);
    return this.tokens.get(hash);
  }
  findHostKey(hash: string): HostKeyRecord | undefined {
    this.calls.push(["findHostKey", hash]);
    return this.keys.get(hash);
  }
  person(id: string) {
    this.calls.push(["person", id]);
    return this.settings.people.find(({ personId }) => personId === id);
  }
  createToken(
    id: string,
    label: string,
    hash: string,
  ): TokenRecord | undefined {
    this.calls.push(["createToken", id, label, hash]);
    if (!this.settings.people.some(({ personId }) => id === personId))
      return undefined;
    const record = { personId: id, label, tokenId: "tok_new", tokenHash: hash };
    this.tokens.set(hash, record);
    return record;
  }
  createHostKey(
    id: string,
    label: string,
    hash: string,
  ): HostKeyRecord | undefined {
    this.calls.push(["createHostKey", id, label, hash]);
    if (!this.settings.people.some(({ personId }) => id === personId))
      return undefined;
    const record = {
      personId: id,
      label,
      hostInstanceId: "hst_new",
      keyHash: hash,
    };
    this.keys.set(hash, record);
    return record;
  }
  revokeToken(id: string): boolean {
    this.calls.push(["revokeToken", id]);
    const record = [...this.tokens.values()].find(
      ({ tokenId }) => tokenId === id,
    );
    return record ? this.tokens.delete(record.tokenHash) : false;
  }
  revokeHostKey(id: string): boolean {
    this.calls.push(["revokeHostKey", id]);
    const record = [...this.keys.values()].find(
      ({ hostInstanceId }) => hostInstanceId === id,
    );
    return record ? this.keys.delete(record.keyHash) : false;
  }
  hello(caller: Caller, input: HelloInput): HubResult<HelloOutput> {
    this.calls.push(["hello", caller, input]);
    return ok(helloResult);
  }
  inbox(caller: Caller, input: InboxInput): HubResult<InboxOutput> {
    this.calls.push(["inbox", caller, input]);
    return ok(inboxResult);
  }
  wait(
    caller: Caller,
    input: WaitInput,
    signal: AbortSignal,
  ): Promise<HubResult<WaitOutput>> {
    this.calls.push(["wait", caller, input, signal]);
    return Promise.resolve(ok(waitResult));
  }
  ask(caller: Caller, input: AskInput): Promise<HubResult<AskOutput>> {
    this.calls.push(["ask", caller, input]);
    return Promise.resolve(
      ok({
        askId: "ask_a",
        status: "open",
        pendingTo: [],
        deliveredTo: [],
        expiresAt: "2026-01-02T00:00:00.000Z",
      }),
    );
  }
  reply(caller: Caller, input: ReplyInput): Promise<HubResult<ReplyOutput>> {
    this.calls.push(["reply", caller, input]);
    return Promise.resolve(
      ok({
        conversationId: "cnv_a",
        chatMessageId: "ref_a",
        postedAs: "Forge",
      }),
    );
  }
  report(caller: Caller, input: ReportInput): Promise<HubResult<ReportOutput>> {
    this.calls.push(["report", caller, input]);
    return Promise.resolve(
      ok({ permitId: "pmt_a", summaryRevision: 1, summary: "edited" }),
    );
  }
  send(caller: Caller, input: SendInput): Promise<HubResult<SendOutput>> {
    this.calls.push(["send", caller, input]);
    return Promise.resolve(ok({ itemId: "itm_a" }));
  }
  hookSession(
    caller: HostCaller,
    input: HookSessionInput,
  ): HubResult<HookSessionOutput> {
    this.calls.push(["hookSession", caller, input]);
    return ok({
      sessionId: "ses_a",
      mode: "normal",
      unread: 3,
      unreadFromOthers: 2,
      itemIds: [],
    });
  }
  hookMode(
    caller: HostCaller,
    input: HookModeInput,
  ): HubResult<HookModeOutput> {
    this.calls.push(["hookMode", caller, input]);
    return ok({ sessionId: "ses_a", mode: "normal" });
  }
  hookStop(
    caller: HostCaller,
    input: HookStopInput,
  ): Promise<HubResult<HookStopOutput>> {
    this.calls.push(["hookStop", caller, input]);
    return Promise.resolve(ok({ result: "posted" }));
  }
  cliInbox(
    caller: typeof person,
    input: CliInboxInput,
  ): HubResult<CliInboxOutput> {
    this.calls.push(["cliInbox", caller, input]);
    return ok({
      sessionId: "ses_a",
      created: input.sessionId === undefined,
      items: [],
      more: false,
    });
  }
  cliSend(caller: typeof person, input: CliSendInput): HubResult<SendOutput> {
    this.calls.push(["cliSend", caller, input]);
    return ok({ itemId: "itm_a" });
  }
}

export function deps(
  settings = config(),
  core = new FakeHubCore(settings),
  log = new FakeLog(),
) {
  return { config: settings, core, log };
}

export const eras = ["2025-11-25", "2026-07-28"] as const;
export type Era = (typeof eras)[number];

export function request(
  path: string,
  body: unknown,
  bearer?: string,
  extra: RequestInit = {},
) {
  const headers = new Headers(extra.headers);
  if (!headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (bearer !== undefined) headers.set("authorization", "Bearer " + bearer);
  return new Request("http://127.0.0.1" + path, {
    method: "POST",
    body: JSON.stringify(body),
    ...extra,
    headers,
  });
}

export function rpcRequest(
  method: string,
  params: Record<string, unknown> = {},
  era: Era = "2026-07-28",
  signal?: AbortSignal,
) {
  const meta =
    era === "2025-11-25"
      ? {}
      : {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": era,
            "io.modelcontextprotocol/clientInfo": {
              name: "fixture",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        };
  return request(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method, params: { ...params, ...meta } },
    token,
    {
      headers: { accept: "application/json, text/event-stream" },
      ...(signal ? { signal } : {}),
    },
  );
}

export async function readRpc(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  const payload = (response.headers.get("content-type") ?? "").startsWith(
    "text/event-stream",
  )
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  if (!payload) throw new Error("Missing RPC response");
  return JSON.parse(payload) as Record<string, unknown>;
}

export async function callTool(
  handler: RemoteHandler,
  name: string,
  input: unknown,
  era?: Era,
) {
  const response = await handler.handle(
    rpcRequest("tools/call", { name, arguments: input }, era),
  );
  return { status: response.status, message: await readRpc(response) };
}

export function toolResult(message: Record<string, unknown>) {
  return message.result as {
    structuredContent: {
      ok: boolean;
      status: string;
      op: string;
      result?: unknown;
      error?: HubError;
      warnings: unknown[];
    };
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };
}
