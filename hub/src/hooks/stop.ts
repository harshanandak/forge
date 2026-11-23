import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { HOOK_STOP_TEXT_MAX, call, input, object } from "./shared.js";

async function transcriptText(path: string) {
  await using stream = createReadStream(path);
  using lines = createInterface({ input: stream, crlfDelay: Infinity });
  let latest: unknown;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = object(JSON.parse(line));
    if (entry?.type === "assistant") latest = object(entry.message)?.content;
  }
  if (!Array.isArray(latest)) return "";
  const blocks: readonly unknown[] = latest;
  const parts: string[] = [];
  for (const item of blocks) {
    const block = object(item);
    if (!block || typeof block.type !== "string") return "";
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") return "";
    parts.push(block.text);
  }
  return parts.join("");
}

async function runStop() {
  const event = await input();
  if (!event || event.stop_hook_active !== false) return;
  const path = event.transcript_path;
  let text = event.last_assistant_message;
  if (typeof text !== "string" && typeof path === "string")
    text = await transcriptText(path);
  if (typeof text !== "string") return;
  const answer = text.trim().slice(0, HOOK_STOP_TEXT_MAX);
  if (answer) await call("stop", event.session_id, { text: answer });
}

await runStop().catch(() => undefined);
