import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const op = process.argv[2];
const command = op === "guard.command";
const unavailable =
  "Forge credential guard could not check this tool call or result.";

function deny(reason) {
  return command
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }
    : { decision: "block", reason };
}

function response(input) {
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../dist/bin/forge.js", import.meta.url)),
      "--hook",
      op,
    ],
    {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 65536,
    },
  );
  if (child.error || child.status !== 0) throw new Error();
  const envelope = JSON.parse(child.stdout);
  const result = envelope?.result;
  if (
    envelope?.ok !== true ||
    envelope.op !== op ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  )
    throw new Error();
  if (Object.keys(result).length === 0) return {};
  if (
    !command &&
    result.decision === "block" &&
    typeof result.reason === "string"
  )
    return deny(result.reason);
  if (command) {
    if (
      result.permission === "deny" &&
      typeof result.agent_message === "string"
    )
      return deny(result.agent_message);
    const hook = result.hookSpecificOutput;
    if (hook?.hookEventName === "PreToolUse") {
      if (
        hook.permissionDecision === "deny" &&
        typeof hook.permissionDecisionReason === "string"
      )
        return { hookSpecificOutput: hook };
      if (
        hook.permissionDecision === undefined &&
        typeof hook.additionalContext === "string"
      )
        return {
          hookSpecificOutput: hook,
          systemMessage: hook.additionalContext,
        };
    }
  }
  throw new Error();
}

let result = deny(unavailable);
try {
  if (!command && op !== "guard.output") throw new Error();
  const chunks = [];
  let bytes = 0;
  const limit = 1024 * 1024;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error();
    chunks.push(chunk);
  }
  result = response(Buffer.concat(chunks));
} catch {
  process.stdin.destroy();
}
process.stdout.write(JSON.stringify(result) + "\n");
