import { Actions, Button, Card, CardText, type CardElement } from "chat";
import {
  ASK_ACTION_PREFIX,
  SUMMARY_KEY_MARKER,
  type AskCardView,
} from "../contract/chat.ts";
import type { Summary } from "../contract/domain.ts";

export function escapeSlackText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderAskCard(view: AskCardView): CardElement {
  const {
    askId,
    kind,
    projectName,
    askedForName,
    requesterName,
    issueId,
    question,
    state,
    choices,
  } = view;
  const subject = issueId ? projectName + " / " + issueId : projectName;
  const heading =
    kind === "work_request"
      ? "Approve work on " +
        subject +
        " requested by " +
        (requesterName ?? "your agent") +
        ":"
      : "Ask for " + askedForName + " on " + projectName;
  const card = [CardText(escapeSlackText(heading + "\n" + question))];
  if (state.kind === "answered")
    card.push(
      CardText(
        escapeSlackText(
          "Answered by " + state.answeredByName + ": " + state.choiceLabel,
        ),
      ),
    );
  if (state.kind === "expired") card.push(CardText("This ask has expired."));
  if (state.kind !== "open") return Card({ children: card });
  if (state.digitFallback) {
    const instructions = [
      "Typed reply",
      ...choices.map(
        (choice, i) => "Reply " + (i + 1) + " for " + choice.label,
      ),
      "Reply under this card with the number, or send " +
        askId +
        " <number> in this DM.",
    ];
    return Card({
      children: [...card, CardText(escapeSlackText(instructions.join("\n")))],
    });
  }
  const buttons = choices.map(({ id, label }) =>
    Button({
      id: ASK_ACTION_PREFIX + id,
      label: escapeSlackText(label),
      value: askId,
      ...(kind === "work_request" && id === "approve"
        ? { style: "primary" as const }
        : {}),
      ...(kind === "work_request" && id === "decline"
        ? { style: "danger" as const }
        : {}),
    }),
  );
  return Card({ children: [...card, Actions(buttons)] });
}

export function renderTextCard(text: string): CardElement {
  return Card({ children: [CardText(escapeSlackText(text))] });
}

export function renderSummaryCard(
  summary: Summary,
  publicationKey?: string,
): CardElement {
  const children = [
    CardText(escapeSlackText(summary.projectName), { style: "bold" }),
    ...summary.lines.map((line) => {
      const issue = [line.issueId, line.issueTitle].filter(Boolean).join(" ");
      const detail = [
        line.personName,
        line.hostLabel,
        line.state,
        issue,
      ].filter(Boolean);
      return CardText(escapeSlackText(detail.join(" / ") + "\n" + line.text));
    }),
  ];
  if (publicationKey !== undefined)
    children.push(
      CardText(SUMMARY_KEY_MARKER + publicationKey, { style: "muted" }),
    );
  return Card({ children });
}
