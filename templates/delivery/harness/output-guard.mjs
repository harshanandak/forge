import { scan } from "./output-scanner.mjs";

const warning =
  "A tool result may contain a credential. Do not repeat it; tell the user to rotate it.";
const harness = process.argv[2];
const limit = 1_048_576;
let finished = false,
  size = 0;
const chunks = [];
const timer = setTimeout(() => finish(), 1000);
function finish(output) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.stdin.pause();
  if (output)
    process.stdout.write(JSON.stringify(output) + "\n", () => process.exit(0));
  else process.exit(0);
}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
let deadline;
function inspect(value, key, depth = 0) {
  if (depth > 64 || performance.now() > deadline) throw new Error();
  if (typeof value === "string") return scan(value, key, deadline);
  if (Array.isArray(value))
    return value.some((item) => inspect(item, undefined, depth + 1));
  if (object(value))
    return Object.entries(value).some(([name, item]) =>
      inspect(
        item,
        /^(stdout|stderr)$/.test(name) ? undefined : name,
        depth + 1,
      ),
    );
  return false;
}
function handle() {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const failure =
      harness === "claude" && input?.hook_event_name === "PostToolUseFailure";
    if (
      !["claude", "codex"].includes(harness) ||
      !object(input) ||
      (!failure && input.hook_event_name !== "PostToolUse") ||
      !("tool_response" in input || (failure && "error" in input))
    )
      return finish();
    deadline = performance.now() + 100;
    if (!inspect(input.tool_response) && !(failure && inspect(input.error)))
      return finish();
    finish(
      harness === "codex"
        ? { systemMessage: warning }
        : {
            hookSpecificOutput: {
              hookEventName: failure ? "PostToolUseFailure" : "PostToolUse",
              additionalContext: warning,
            },
          },
    );
  } catch {
    finish();
  }
}
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > limit) return finish();
  chunks.push(chunk);
});
process.stdin.on("end", handle);
process.stdin.on("error", () => finish());
process.stdout.on("error", () => process.exit(0));
