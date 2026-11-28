import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  HubCore,
  HubResult,
  HostKeyRecord,
  TokenRecord,
} from "../../src/contract/core.ts";
import {
  SECRET_PATTERNS,
  type HubError,
  type HubErrorCode,
} from "../../src/contract/errors.ts";
import type {
  HubConfig,
  HubLog,
  LogFields,
  RemoteHandler,
} from "../../src/contract/runtime.ts";
import { createRemoteHandler } from "../../src/remote/index.ts";

export const person = { personId: "per_owner", displayName: "Owner" };
export const token = ["f", "h_", "a".repeat(43)].join("");
export const key = ["fh", "k_", "b".repeat(43)].join("");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const ok = <T>(value: T): HubResult<T> => ({ ok: true, value });
export const done = <T>(value: T) => Promise.resolve(ok(value));
export const fail = (
  code: HubErrorCode,
  details: Partial<HubError> = {},
): HubResult<never> => ({
  ok: false,
  error: { message: code, retry: "never", ...details, code },
});
const empty = { items: [], answers: [], mode: "normal" } as const;
export const inboxResult = { ...empty, more: false };
export const waitResult = { ...empty, status: "pending" } as const;
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
export const registered = {
  ...pickSession(),
  unread: 3,
  unreadFromOthers: 2,
  itemIds: [],
};
function pickSession() {
  return { sessionId: "ses_a", mode: "normal" } as const;
}
export const askResult = {
  askId: "ask_a",
  status: "open",
  pendingTo: [],
  deliveredTo: [],
  expiresAt: "2026-01-02T00:00:00Z",
} as const;

export function config(overrides: Partial<HubConfig> = {}): HubConfig {
  const { personId } = person;
  return {
    listen: { host: "127.0.0.1", port: 3775 },
    basePath: "",
    dataDir: "fixture",
    allowedHosts: ["127.0.0.1:3775"],
    allowedOrigins: ["https://hub.example"],
    slack: { mode: "socket", buttons: true },
    mcp: { enabled: true },
    hooks: { enabled: true },
    cli: { enabled: true },
    people: [person],
    doorbells: [],
    projects: [
      {
        projectId: "prj_demo",
        name: "Demo",
        frontPersonId: personId,
        memberIds: [personId],
      },
    ],
    ...overrides,
  };
}

export function fakeLog() {
  const fields: Array<[string, string, LogFields | undefined]> = [];
  const log = (level: string) => (event: string, data?: LogFields) => {
    fields.push([level, event, data]);
  };
  return {
    fields,
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  } satisfies HubLog & { fields: typeof fields };
}

type Recorded<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => ReturnType<T>;
type TestCore = {
  -readonly [K in keyof HubCore]: HubCore[K] extends (
    ...args: never[]
  ) => unknown
    ? Recorded<HubCore[K]>
    : HubCore[K];
};

function revoke<R>(records: Map<string, R>, matches: (record: R) => boolean) {
  for (const [hash, record] of records)
    if (matches(record)) return records.delete(hash);
  return false;
}

export function fakeCore(settings = config()) {
  const calls: Array<[string, ...unknown[]]> = [];
  const { personId } = person;
  const label = "test";
  const tokenHash = digest(token);
  const keyHash = digest(key);
  const tokens = new Map<string, TokenRecord>([
    [tokenHash, { tokenId: "tok_a", personId, label, tokenHash }],
  ]);
  const keys = new Map<string, HostKeyRecord>([
    [keyHash, { hostInstanceId: "hst_a", personId, label, keyHash }],
  ]);
  const find = (id: string) =>
    settings.people.find((entry) => entry.personId === id);
  const record =
    <K extends keyof TestCore, A extends unknown[], R>(
      name: K,
      fn: (...args: A) => R,
    ) =>
    (...args: A) => {
      calls.push([name, ...args]);
      return fn(...args);
    };
  const noop = () => Promise.resolve();
  const message = { itemId: "itm_a" };
  const api: TestCore = {
    chatHandlers: {
      onAction: () => Promise.reject(new Error("Unexpected action")),
      onMessage: noop,
      onMessageChange: noop,
    },
    start: noop,
    close: noop,
    person: record("person", find),
    findToken: record("findToken", (hash: string) => tokens.get(hash)),
    findHostKey: record("findHostKey", (hash: string) => keys.get(hash)),
    createToken: record(
      "createToken",
      (personId: string, label: string, tokenHash: string) => {
        if (!find(personId)) return undefined;
        const value = { tokenId: "tok_new", personId, label, tokenHash };
        tokens.set(tokenHash, value);
        return value;
      },
    ),
    createHostKey: record(
      "createHostKey",
      (personId: string, label: string, keyHash: string) => {
        if (!find(personId)) return undefined;
        const value = { hostInstanceId: "hst_new", personId, label, keyHash };
        keys.set(keyHash, value);
        return value;
      },
    ),
    revokeToken: record("revokeToken", (id: string) =>
      revoke(tokens, (entry) => entry.tokenId === id),
    ),
    revokeHostKey: record("revokeHostKey", (id: string) =>
      revoke(keys, (entry) => entry.hostInstanceId === id),
    ),
    hello: record("hello", (..._args: Parameters<HubCore["hello"]>) =>
      ok(helloResult),
    ),
    inbox: record("inbox", (..._args: Parameters<HubCore["inbox"]>) =>
      ok(inboxResult),
    ),
    wait: record("wait", (..._args: Parameters<HubCore["wait"]>) =>
      done(waitResult),
    ),
    ask: record("ask", (..._args: Parameters<HubCore["ask"]>) =>
      done(askResult),
    ),
    reply: record("reply", (..._args: Parameters<HubCore["reply"]>) =>
      done({
        conversationId: "cnv_a",
        chatMessageId: "ref_a",
        postedAs: "Forge",
      }),
    ),
    report: record("report", (..._args: Parameters<HubCore["report"]>) =>
      done({ permitId: "pmt_a", summaryRevision: 1, summary: "edited" }),
    ),
    send: record("send", (..._args: Parameters<HubCore["send"]>) =>
      done(message),
    ),
    hookSession: record(
      "hookSession",
      (..._args: Parameters<HubCore["hookSession"]>) => ok(registered),
    ),
    hookMode: record("hookMode", (..._args: Parameters<HubCore["hookMode"]>) =>
      ok(pickSession()),
    ),
    hookStop: record("hookStop", (..._args: Parameters<HubCore["hookStop"]>) =>
      done({ result: "posted" }),
    ),
    cliInbox: record(
      "cliInbox",
      (...[, input]: Parameters<HubCore["cliInbox"]>) =>
        ok({
          sessionId: "ses_a",
          created: input.sessionId === undefined,
          items: [],
          more: false,
        }),
    ),
    cliSend: record("cliSend", (..._args: Parameters<HubCore["cliSend"]>) =>
      done(message),
    ),
  };
  return Object.assign(api, { calls, tokens, keys });
}

export function deps(settings = config()) {
  return { config: settings, core: fakeCore(settings), log: fakeLog() };
}

export function safeOutput(text: string, extras: readonly string[] = []) {
  for (const pattern of SECRET_PATTERNS) expect(text).not.toMatch(pattern);
  for (const value of [digest(key), digest(token), "Bearer", ...extras])
    expect(text).not.toContain(value);
}

export type RemoteCase = ReturnType<typeof deps> & {
  handler: RemoteHandler;
  handle: (req: Request) => Promise<Response>;
  names: () => string[];
};
export function remoteTest(timeout: number) {
  return (
    name: string,
    run: (c: RemoteCase) => Promise<void>,
    settings = config(),
    make = createRemoteHandler,
  ) =>
    test(
      name,
      async () => {
        const fixture = deps(settings);
        const handler = make(fixture);
        const hashes = new Set<string>();
        const handle = async (req: Request) => {
          const credential = req.headers.get("authorization");
          if (credential?.startsWith("Bearer "))
            hashes.add(digest(credential.slice(7)));
          const response = await handler.handle(req);
          safeOutput(await response.clone().text(), [...hashes]);
          return response;
        };
        try {
          await run({
            ...fixture,
            handler,
            handle,
            names: () => fixture.core.calls.map(([name]) => name),
          });
        } finally {
          await handler.close();
          safeOutput(JSON.stringify(fixture.log.fields), [...hashes]);
        }
      },
      timeout,
    );
}

export const eras = ["2025-11-25", "2026-07-28"] as const;
export type Era = (typeof eras)[number];
export function request(
  path: string,
  body: unknown,
  bearer?: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (bearer !== undefined) headers.set("authorization", "Bearer " + bearer);
  return new Request("http://127.0.0.1" + path, {
    method: "POST",
    body: JSON.stringify(body),
    ...init,
    headers,
  });
}

export function rpcRequest(
  method: string,
  params: Record<string, unknown> = {},
  era: Era = "2026-07-28",
) {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": era,
    "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: era === eras[0] ? params : { ...params, _meta: meta },
  };
  const headers = new Headers({
    accept: "application/json, text/event-stream",
  });
  if (era !== eras[0]) {
    headers.set("MCP-Protocol-Version", era);
    headers.set("Mcp-Method", method);
    if (method === "tools/call" && typeof params.name === "string")
      headers.set("Mcp-Name", params.name);
  }
  return request("/mcp", body, token, { headers });
}

export function json<T>(text: string): T {
  return JSON.parse(text) as T;
}
export async function readRpc(response: Response) {
  const text = await response.text();
  const payload = response.headers
    .get("content-type")
    ?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  if (!payload) throw new Error("Missing RPC response");
  return json<Record<string, unknown>>(payload);
}

export type WireEnvelope = {
  ok: boolean;
  status: string;
  op: string;
  result?: unknown;
  error?: HubError;
  warnings: unknown[];
};
export async function rpc(
  handle: RemoteCase["handle"],
  name: string,
  input: unknown,
  era?: Era,
) {
  const response = await handle(
    rpcRequest("tools/call", { name, arguments: input }, era),
  );
  const message = await readRpc(response);
  return {
    status: response.status,
    message,
    tool: message.result as {
      structuredContent: WireEnvelope;
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    },
  };
}
