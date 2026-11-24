import type { TrackerReader } from "../contract/domain.ts";
import type {
  CreateHubCore,
  CreatePeopleDirectory,
  DoctorCheck,
  HubConfig,
  OpenHubDb,
  ProtectPath,
} from "../contract/runtime.ts";
import { openHubDb as openDb } from "./db.ts";
import { protectPath as verifyPath } from "./protect.ts";

function notBuilt(): never {
  throw new Error("not_built");
}

export const openHubDb: OpenHubDb = openDb;
export const createHubCore: CreateHubCore = notBuilt;
export { loadConfig } from "./config.ts";
export const nullTracker: TrackerReader = {
  issue: () => Promise.resolve(undefined),
};
export const createPeopleDirectory: CreatePeopleDirectory = notBuilt;
export const protectPath: ProtectPath = verifyPath;
export { protectDirectoryChain } from "./protect.ts";
export { createPrivateDirectory } from "./protect.ts";
export { createPrivateFile } from "./protect.ts";
export const inspectStorage: (config: HubConfig) => readonly DoctorCheck[] =
  notBuilt;
