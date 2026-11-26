import type { AskCardView } from "../contract/chat.ts";

export interface TelegramAskCard {
  readonly text: string;
  readonly reply_markup: {
    readonly inline_keyboard: readonly (readonly {
      readonly text: string;
      readonly callback_data: string;
    }[])[];
  };
}

export function renderTelegramAskCard(_card: AskCardView): TelegramAskCard {
  throw new Error("not_built");
}
