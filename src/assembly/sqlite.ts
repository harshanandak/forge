import {
  createSqliteStore as createStore,
  type RestoreHooks,
} from "../adapters/store-sqlite/index.ts";
import { windowsPrivateFiles } from "../adapters/process/windows-acl.ts";
import {
  privateFileGuard,
  type PrivateFileGuard,
} from "../adapters/store-sqlite/private-files.ts";
import type { StorePort } from "../ports/store.ts";

export {
  StoreRestoringError,
  sqliteIdentityError,
  type RestoreHooks,
} from "../adapters/store-sqlite/index.ts";

let security: PrivateFileGuard | undefined;
const defaultGuard: PrivateFileGuard = {
  directory(path) {
    security ??= privateFileGuard(windowsPrivateFiles());
    security.directory(path);
  },
  file(path) {
    security ??= privateFileGuard(windowsPrivateFiles());
    security.file(path);
  },
};

/** Public hosts receive the same native file protection as the CLI assembly. */
export function createSqliteStore(
  basePath: string,
  hooks: RestoreHooks = {},
): StorePort {
  if (process.platform !== "win32" || hooks.security || hooks.fs?.security)
    return createStore(basePath, hooks);
  return createStore(basePath, { ...hooks, security: defaultGuard });
}

export const sqliteStore: StorePort = {
  open(options) {
    return createSqliteStore(process.cwd()).open(options);
  },
};
