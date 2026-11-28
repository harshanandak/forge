import type { FakeChatPort } from "../fakes/fake-chat.ts";

export function holdFirstSummaryEdit(
  chat: FakeChatPort,
  outcome: "delay" | "unknown" = "delay",
) {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const edit = chat.editSummary.bind(chat);
  chat.editSummary = (ref, summary) => {
    if (summary.revision !== 1) return edit(ref, summary);
    chat.nextWrite =
      outcome === "unknown"
        ? { kind: "unknown", until: gate.promise }
        : { kind: "delay", until: gate.promise };
    const pending = edit(ref, summary);
    started.resolve();
    return pending;
  };
  return { started: started.promise, release: gate.resolve };
}

export function holdFirstAskEdit(chat: FakeChatPort) {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const edit = chat.editAskDm.bind(chat);
  let held = false;
  chat.editAskDm = (ref, card) => {
    if (held) return edit(ref, card);
    held = true;
    chat.nextWrite = { kind: "delay", until: gate.promise };
    const pending = edit(ref, card);
    started.resolve();
    return pending;
  };
  return { started: started.promise, release: gate.resolve };
}
