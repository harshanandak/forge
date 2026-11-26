import { LIMITS, LONG_ANSWER_SEPARATOR } from "../contract/mcp.ts";

export interface SplitAnswer {
  readonly short: string;
  readonly long: boolean;
}

export const SECTION_BUDGET = 3000;
const SECTION_CUT_MARKER = "[...]";

function escapedWidth(text: string): number {
  let total = 0;
  for (let index = 0; index < text.length; index++) {
    const ch = text.charAt(index);
    total += ch === "&" ? 5 : ch === "<" || ch === ">" ? 4 : 1;
  }
  return total;
}

export function fitSection(head: string, body: string): string {
  if (escapedWidth(head + body) <= SECTION_BUDGET) return head + body;
  let allowance =
    SECTION_BUDGET - escapedWidth(head) - SECTION_CUT_MARKER.length;
  if (allowance < 0) allowance = 0;
  let width = 0;
  let start = body.length;
  while (start > 0) {
    const ch = body.charAt(start - 1);
    width += ch === "&" ? 5 : ch === "<" || ch === ">" ? 4 : 1;
    if (width > allowance) break;
    start -= 1;
  }
  return head + SECTION_CUT_MARKER + body.slice(start);
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
