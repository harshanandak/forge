import type { TrackerReader } from "../contract/domain.ts";
import type { CreateHubCore } from "../contract/runtime.ts";

function notBuilt(): never {
  throw new Error("not_built");
}

export { openHubDb } from "./db.ts";
export const createHubCore: CreateHubCore = notBuilt;
export { createPeopleDirectory, inspectStorage, loadConfig } from "./config.ts";
export const nullTracker: TrackerReader = {
  issue: () => Promise.resolve(undefined),
};
export {
  createPrivateDirectory,
  createPrivateFile,
  protectDirectoryChain,
  protectPath,
} from "./protect.ts";
