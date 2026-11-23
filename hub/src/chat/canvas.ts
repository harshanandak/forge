import type { ChatPort } from "../contract/chat.ts";

export const createLongAnswer: ChatPort["createLongAnswer"] = () => {
  throw new Error("not_built");
};
