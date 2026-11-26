import { LIMITS, LONG_ANSWER_SEPARATOR } from "../contract/mcp.ts";

export interface SplitAnswer {
  readonly short: string;
  readonly long: boolean;
}

function cutToLimit(text: string): string {
  if (text.length <= LIMITS.shortAnswer) return text;
  const head = text.slice(0, LIMITS.shortAnswer);
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph > 0) return head.slice(0, paragraph);
  const whitespace = head.search(/\s+\S*$/);
  if (whitespace > 0) return head.slice(0, whitespace);
  return head;
}

export function splitAnswer(text: string): SplitAnswer {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line === LONG_ANSWER_SEPARATOR);
  if (at >= 0) {
    const head = lines.slice(0, at).join("\n");
    const tail = lines.slice(at + 1).join("\n");
    if (tail.length === 0) {
      const short = cutToLimit(head);
      return { short, long: head.length > LIMITS.shortAnswer };
    }
    return { short: cutToLimit(head), long: true };
  }
  if (text.length <= LIMITS.shortAnswer) return { short: text, long: false };
  return { short: cutToLimit(text), long: true };
}
