import type { AskCardView } from "../contract/chat.ts";
import type { Summary } from "../contract/domain.ts";

export type TelegramAskCard = ReturnType<typeof renderTelegramAskCard>;

export const askCallbackPrefix = "fa1:";

export function telegramText(text: string, limit = 4_096): string {
  return text.length <= limit
    ? text
    : text.slice(0, limit - 1).replace(/\p{Surrogate}$/u, "") + "…";
}

export function renderTelegramAskCard(view: AskCardView) {
  const { state, choices } = view;
  const subject = [view.projectName, view.issueId].filter(Boolean).join(" / ");
  const requester = view.requesterName ?? "your agent";
  const heading =
    view.kind === "work_request"
      ? `Approve work on ${subject} requested by ${requester}`
      : `Ask for ${view.askedForName} on ${subject}`;
  const lines = [heading, view.question];
  if (state.kind === "answered")
    lines.push(`Answered by ${state.answeredByName}: ${state.choiceLabel}`);
  if (state.kind === "expired") lines.push("This ask has expired.");
  if (state.kind === "open" && state.digitFallback) {
    for (const [index, { label }] of choices.entries())
      lines.push(`${index + 1}. ${label}`);
    lines.push(`Reply with a number, or send ${view.askId} <number>.`);
  }
  const buttons =
    state.kind === "open" && !state.digitFallback
      ? choices.map(({ label }, index) => [
          { text: label, callback_data: askCallbackPrefix + index },
        ])
      : [];
  return {
    text: telegramText(lines.join("\n")),
    reply_markup: { inline_keyboard: buttons },
  };
}

export function renderTelegramSummary(summary: Summary): string {
  const lines = summary.lines.map(
    ({ personName, hostLabel, state, issueId, issueTitle, text }) => {
      const heading = [
        personName,
        hostLabel,
        state,
        issueId,
        issueTitle,
      ].filter(Boolean);
      return heading.join(" / ") + "\n" + text;
    },
  );
  return telegramText([summary.projectName, ...lines].join("\n\n"));
}
