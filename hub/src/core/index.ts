import type { TrackerReader } from "../contract/domain.ts";
import type {
  CreateHubCore,
  CreatePeopleDirectory,
  DoctorCheck,
  HubConfig,
  OpenHubDb,
  ProtectPath,
} from "../contract/runtime.ts";

function notBuilt(): never {
  throw new Error("not_built");
}

export const openHubDb: OpenHubDb = notBuilt;
export const createHubCore: CreateHubCore = notBuilt;
export const loadConfig: (path: string) => HubConfig = notBuilt;
export const nullTracker: TrackerReader = { issue: notBuilt };
export const createPeopleDirectory: CreatePeopleDirectory = notBuilt;
export const protectPath: ProtectPath = notBuilt;
export const inspectStorage: (config: HubConfig) => readonly DoctorCheck[] =
  notBuilt;
