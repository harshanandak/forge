import { ChatWriteFailure, type ChatPort } from "../contract/chat.ts";

export const createLongAnswer: ChatPort["createLongAnswer"] = () =>
  Promise.reject(
    new ChatWriteFailure("refused", undefined, "canvas_unavailable"),
  );
