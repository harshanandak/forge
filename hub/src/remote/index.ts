import type {
  CreateDoorbell,
  CreateRemoteHandler,
  HashSecret,
  RunAdminCommand,
} from "../contract/runtime.ts";

function notBuilt(): never {
  throw new Error("not_built");
}

export const createRemoteHandler: CreateRemoteHandler = notBuilt;
export const createDoorbell: CreateDoorbell = notBuilt;
export const hashSecret: HashSecret = notBuilt;
export const runAdminCommand: RunAdminCommand = notBuilt;
