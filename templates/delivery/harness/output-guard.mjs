import { scan, safeLabel } from "./output-scanner.mjs";

const harness = process.argv[2];
const limit = 1_048_576;
let finished = false,
  size = 0;
const chunks = [];
const values = [];
const timer = setTimeout(() => note("timeout"), 1000);
function finish(output) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.stdin.pause();
  if (output)
    process.stdout.write(JSON.stringify(output) + "\n", () => process.exit(0));
  else process.exit(0);
}
function note(reason = "unsupported or malformed payload") {
  finish({
    systemMessage: `Forge output guard: input not scanned (${reason}).`,
  });
}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
let deadline;
function safeWarning(warning, replacement = "") {
  for (const value of values)
    for (const text of [warning, replacement]) {
      if (performance.now() > deadline) throw new Error();
      if (text.includes(value)) return "";
      for (let i = 0; i + 8 <= value.length; i++) {
        if (performance.now() > deadline) throw new Error();
        if (text.includes(value.slice(i, i + 8))) return "";
      }
    }
  return warning;
}
function inspect(value, names, key, depth = 0) {
  if (depth > 64 || performance.now() > deadline) throw new Error();
  if (typeof value === "string") {
    const result = scan(value, key, deadline);
    for (const finding of result.findings) {
      names.set(finding.name, finding.family);
      values.push(value.slice(finding.start, finding.end));
    }
    return result.redacted;
  }
  if (Array.isArray(value))
    return value.map((item) => inspect(item, names, undefined, depth + 1));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        inspect(
          item,
          names,
          /^(stdout|stderr)$/.test(name) ? undefined : name,
          depth + 1,
        ),
      ]),
    );
  return value;
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
      return note();
    const names = new Map();
    deadline = performance.now() + 100;
    const updated = inspect(input.tool_response, names);
    if (failure) inspect(input.error, names);
    if (!names.size) return finish();
    const labels = [...names]
      .slice(0, 20)
      .map(
        ([name, family]) =>
          safeLabel(name, values, deadline) ?? `unknown key (${family})`,
      );
    const warning = `Forge output guard detected credentials: ${labels.join(", ")}. Rotate affected credentials and rerun with output suppressed or redacted.`;
    if (harness === "codex")
      return finish({ decision: "block", reason: safeWarning(warning) });
    const response = input.tool_response;
    const known =
      !failure &&
      input.tool_name === "Bash" &&
      object(response) &&
      typeof response.stdout === "string" &&
      typeof response.stderr === "string" &&
      Object.entries(response).every(([name, value]) =>
        /^(stdout|stderr)$/.test(name)
          ? typeof value === "string"
          : /^(interrupted|isImage)$/.test(name) && typeof value === "boolean",
      );
    if (known)
      for (const name of Object.keys(updated)) {
        if (typeof updated[name] !== "string") continue;
        for (const value of values) {
          if (performance.now() > deadline) throw new Error();
          updated[name] = updated[name].replaceAll(value, "[REDACTED]");
        }
        updated[name] = updated[name].replace(
          /[A-Za-z_][A-Za-z0-9_]{0,63}/g,
          (label) => safeLabel(label, values, deadline) ?? "[REDACTED]",
        );
      }
    finish({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: safeWarning(
          warning + (known ? " Output redacted." : " Output not redacted."),
          known ? JSON.stringify(updated) : "",
        ),
        ...(known ? { updatedToolOutput: updated } : {}),
      },
    });
  } catch {
    note();
  }
}
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > limit) return note("size limit");
  chunks.push(chunk);
});
process.stdin.on("end", handle);
process.stdin.on("error", () => note());
process.stdout.on("error", () => process.exit(0));
