import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";

export const HOOK_PATHS = {
  session: "/hook/session",
  mode: "/hook/mode",
  stop: "/hook/stop",
} as const;
export const HOOK_READ_TOOLS = ["Read", "Glob", "Grep"] as const;
export const HOOK_TIMEOUT_MS = 1500;
export const HOOK_STOP_TIMEOUT_MS = 10000;
export const HOOK_STOP_TEXT_MAX = 20000;
export const hookForgeToolNames = (server: string) =>
  ["hello", "inbox", "ask", "wait", "reply", "report", "send"].map(
    (tool) => `mcp__${server}__${tool}`,
  );

export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as ObjectValue;
}
type HookInput = ObjectValue & { session_id: string };
export async function input(): Promise<HookInput | undefined> {
  const raw = await text(process.stdin);
  try {
    const event = object(JSON.parse(raw));
    const session = event?.session_id;
    if (event && isSession(session)) return { ...event, session_id: session };
  } catch {
    return undefined;
  }
}

export const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z]{2,8}_[A-Za-z0-9_-]{1,64}$/.test(value);
export const isSession = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
export const isMode = (value: unknown) =>
  value === "normal" || value === "reply_only";
export function serverName() {
  const name = process.env.FORGE_HUB_MCP_SERVER ?? "forge-hub";
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : undefined;
}

function hubBase(raw: string) {
  const url = URL.parse(raw);
  if (!url || url.username || url.password || /[?#]/.test(raw)) return;
  if (raw.endsWith("/") || url.pathname.endsWith("/mcp")) return;
  const loopback = /^(127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    return raw;
}

async function hostKey() {
  const path = process.env.FORGE_HUB_HOST_KEY_FILE;
  if (!path) return undefined;
  const raw = await readFile(path, "utf8").catch(() => "");
  const key = raw.replace(/\r?\n$/, "");
  return /^fhk_[A-Za-z0-9_-]{43}$/.test(key) ? key : undefined;
}

export async function call(
  route: keyof typeof HOOK_PATHS,
  hostSessionId: string,
  fields: ObjectValue = {},
) {
  const base = hubBase(process.env.FORGE_HUB_URL ?? "");
  if (!base) return { error: "HUB_URL_INVALID" };
  const key = await hostKey();
  if (!key) return { error: "HOST_KEY_UNAVAILABLE" };
  const stop = route === "stop";
  const timeout = stop ? HOOK_STOP_TIMEOUT_MS : HOOK_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(base + HOOK_PATHS[route], {
      method: "POST",
      redirect: "error",
      signal,
      body: JSON.stringify({ host: "claude", hostSessionId, ...fields }),
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
      },
    });
    if (stop) {
      await response.body?.cancel();
      return {};
    }
    const result = object(await response.json().catch(() => undefined));
    if (signal.aborted) return { error: "HUB_TIMEOUT" };
    if (
      response.status === 200 &&
      result?.ok === true &&
      result.status === "OK"
    ) {
      const value = object(result.result);
      return value ? { value } : { error: "INVALID_RESPONSE" };
    }
    const code = object(result?.error)?.code;
    const validCode =
      typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code);
    return { error: validCode ? code : "INVALID_RESPONSE" };
  } catch {
    return { error: signal.aborted ? "HUB_TIMEOUT" : "HUB_UNREACHABLE" };
  }
}
