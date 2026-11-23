import type { CardElement } from "chat";
import type { AskCardView } from "../contract/chat.ts";
import type { Summary } from "../contract/domain.ts";

export function renderAskCard(_view: AskCardView): CardElement {
  throw new Error("not_built");
}

export function renderTextCard(_text: string): CardElement {
  throw new Error("not_built");
}

export function renderSummaryCard(
  _summary: Summary,
  _publicationKey?: string,
): CardElement {
  throw new Error("not_built");
}
