import type { TrackerReader } from "../contract/domain.ts";

export { openHubDb } from "./db.ts";
export { createHubCore } from "./compose.ts";
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
