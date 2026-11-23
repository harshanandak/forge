import type { createMcpHandler } from "@modelcontextprotocol/server";
import type { FileHandle } from "node:fs/promises";
import type {
  AdminDeps,
  CreateDoorbell,
  CreateRemoteHandler,
  DoorbellDeps,
  HashSecret,
  RemoteDeps,
  RunAdminCommand,
} from "../contract/runtime.ts";
import type { DoorbellPort } from "../contract/hooks.ts";
import type { RemoteHandler } from "../contract/runtime.ts";

export interface RemoteServices {
  readonly makeMcp?: typeof createMcpHandler;
  readonly compare?: (presented: Buffer, stored: Buffer) => boolean;
}

export interface DoorbellServices {
  readonly fetch: (url: URL, init: RequestInit) => Promise<Response>;
  readonly delay: (ms: number) => Promise<void>;
}

export interface PrivatePaths {
  createPrivateDirectory(path: string): Promise<boolean>;
  createPrivateFile(path: string): Promise<FileHandle | null>;
}

function notBuilt(): never {
  throw new Error("not_built");
}

export const createRemoteHandler: CreateRemoteHandler = notBuilt;
export const createDoorbell: CreateDoorbell = notBuilt;
export const hashSecret: HashSecret = notBuilt;
export const runAdminCommand: RunAdminCommand = notBuilt;
export const remoteWith: (
  deps: RemoteDeps,
  services: RemoteServices,
) => RemoteHandler = notBuilt;
export const doorbellWith: (
  deps: DoorbellDeps,
  services: DoorbellServices,
) => DoorbellPort = notBuilt;
export const adminWith: (
  argv: readonly string[],
  deps: AdminDeps,
  paths: PrivatePaths,
) => Promise<number> = notBuilt;
