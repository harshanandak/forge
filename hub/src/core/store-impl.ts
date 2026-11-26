import { createAskEffects } from "./askEffects.ts";
import { createAnswers } from "./answers.ts";
import { createAsk } from "./asks.ts";
import { createCredentialStore, newStoreId } from "./credentials.ts";
import { syncDirectory } from "./directory.ts";
import { createGuards } from "./guards.ts";
import { createSessionStore } from "./sessions.ts";
import type { CoreStore, CreateCoreStore } from "./store.ts";

export const createCoreStore: CreateCoreStore = (deps) => {
  const { db, config, chat } = deps;
  const sessions = createSessionStore(deps);
  const guards = createGuards();
  const store: CoreStore = {
    tx: (body) => db.transaction(body),
    sessions,
    credentials: createCredentialStore(deps),
    guards,
    newId: newStoreId,
    syncDirectory: () => syncDirectory(db, config),
  };
  const adapter = config.chat?.adapter ?? "slack";
  if (
    !chat ||
    adapter === "off" ||
    (adapter === "slack" && config.slack.mode === "off")
  )
    return store;
  const asks = {
    ask: createAsk({ ...deps, chat, adapter }, sessions, guards),
    ...createAnswers({ ...deps, adapter }, sessions),
    ...createAskEffects({ ...deps, adapter }),
  };
  return { ...store, asks };
};
