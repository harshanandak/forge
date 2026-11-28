import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import {
  HOOK_READ_TOOLS,
  call,
  hookForgeToolNames,
  input,
  isId,
  isMode,
  object,
  serverName,
  type ObjectValue,
} from "./shared.js";

const replyOnly =
  "Forge reply-only mode: this session read a message from someone other than its owner. Reply through forge-hub, or ask your owner to approve the work.";
const unconfirmed = (code: string) =>
  `Forge hub could not confirm this session (${code}). Read tools inside the working directory still work.`;

function safePattern(value: unknown) {
  if (typeof value !== "string") return value === undefined;
  return !win32.isAbsolute(value) && !value.includes("..");
}
async function localRead(tool: string, fields: ObjectValue, cwd: string) {
  if (!HOOK_READ_TOOLS.some((name) => name === tool)) return false;
  if (tool === "Glob" && !safePattern(fields.pattern)) return false;
  if (tool === "Grep" && !safePattern(fields.glob)) return false;
  const target = (tool === "Read" ? fields.file_path : fields.path) ?? cwd;
  if (typeof target !== "string") return false;
  if ([cwd, target].some((path) => /^[\\/]{2}/.test(path))) return false;
  try {
    const dir = await realpath(cwd);
    const path = relative(dir, await realpath(resolve(cwd, target)));
    return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
  } catch {
    return false;
  }
}

async function decision() {
  const event = await input();
  const fields = object(event?.tool_input);
  const name = serverName();
  if (!event || !fields || !name) return unconfirmed("INVALID_INPUT");
  const { tool_name: tool, cwd } = event;
  if (typeof tool !== "string" || typeof cwd !== "string" || !cwd)
    return unconfirmed("INVALID_INPUT");
  if (await localRead(tool, fields, cwd)) return undefined;
  const { value, error } = await call("mode", event.session_id);
  if (!value) return unconfirmed(error ?? "INVALID_RESPONSE");
  if (value.mode === "unregistered") return unconfirmed("UNREGISTERED");
  if (!isMode(value.mode) || !isId(value.sessionId))
    return unconfirmed("INVALID_RESPONSE");
  if (hookForgeToolNames(name).includes(tool))
    return fields.sessionId === value.sessionId
      ? undefined
      : `Forge hub: pass sessionId ${value.sessionId} for this session.`;
  return value.mode === "reply_only" ? replyOnly : undefined;
}

export async function runPreTool() {
  const reason = await decision().catch(() => unconfirmed("INVALID_INPUT"));
  if (reason === undefined) return 0;
  process.stderr.write(reason + "\n");
  return 2;
}
