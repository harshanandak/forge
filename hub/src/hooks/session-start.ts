import { call, input, isId, isMode, isSession, serverName } from "./shared.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const unavailable = (code: string) => "Forge hub unavailable: " + code;

async function sessionLine() {
  const event = await input();
  const server = serverName();
  if (!event || !server) return unavailable("INVALID_INPUT");
  const source = event.source;
  const sources = ["startup", "resume", "clear", "compact"];
  if (!sources.some((name) => name === source))
    return unavailable("INVALID_INPUT");
  const threadId = process.env.T3CODE_THREAD_ID;
  const body = { source, ...(isSession(threadId) ? { threadId } : {}) };
  const { value, error } = await call("session", event.session_id, body);
  if (!value) return unavailable(error ?? "INVALID_RESPONSE");
  const { sessionId, mode, unread, unreadFromOthers } = value;
  if (
    !isId(sessionId) ||
    !isMode(mode) ||
    !count(unread) ||
    !count(unreadFromOthers)
  )
    return unavailable("INVALID_RESPONSE");
  return `Forge hub session ${sessionId} (${mode}). ${unread} unread, ${unreadFromOthers} not from you. Call ${server} hello with sessionId ${sessionId}, then inbox.`;
}

export async function runSessionStart() {
  await sessionLine()
    .then((line) => process.stdout.write(line + "\n"))
    .catch(() => undefined);
  return 0;
}
