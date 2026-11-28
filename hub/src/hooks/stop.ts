import { createReadStream } from "node:fs";
import { HOOK_STOP_TEXT_MAX, call, input, object } from "./shared.js";

async function transcriptText(path: string) {
  await using stream = createReadStream(path, { encoding: "utf8" });
  let latest: unknown;
  let pending = "";
  const record = (line: string) => {
    if (!line.trim()) return;
    const entry = object(JSON.parse(line));
    if (entry?.type === "assistant") latest = object(entry.message)?.content;
  };
  for await (const chunk of stream as AsyncIterable<string>) {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) record(line);
  }
  record(pending);
  if (!Array.isArray(latest)) return "";
  const parts: string[] = [];
  for (const item of latest as readonly unknown[]) {
    const block = object(item);
    if (!block || typeof block.type !== "string") return "";
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") return "";
    parts.push(block.text);
  }
  return parts.join("");
}

async function mirrorStop() {
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

export async function runStop() {
  await mirrorStop().catch(() => undefined);
  return 0;
}
