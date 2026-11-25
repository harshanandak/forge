import {
  classifyBotAuthor,
  type BotRecord,
  type Endpoint,
} from "./bot-identity.ts";
import { fail, ok, type Result } from "./result.ts";

export function parseBotMessage(
  record: BotRecord,
  endpoint: Endpoint,
): Result<{ kind: "human" }> {
  const author = classifyBotAuthor(record, endpoint);
  if (!author.ok) return author;
  if (author.value.kind === "human") return ok(author.value);
  return fail("bot_format_unsupported", `${endpoint}/${record.id}`);
}
