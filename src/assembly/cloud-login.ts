// `forge cloud login`: the device flow against one Forge cloud project, then a private credential.
// Stub: behaviour lands with the fix commit.
import type { SurfaceCatalog } from "../surface/catalog.ts";
import type { CloudFetch } from "../adapters/http/index.ts";

export const CLOUD_LOGIN_OP = "cloud.login";

export interface CloudLoginDeps {
  /** The checkout root that holds .forge/project.json. */
  readonly root: string;
  /** The home folder whose .forge/cloud holds the credential file. */
  readonly home: string | undefined;
  /** Where the persistent device id lives. */
  readonly deviceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: CloudFetch;
  readonly now?: () => number;
  /** Sleep that rejects when the signal aborts. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Progress lines; the default writes to stderr. */
  readonly progress?: (line: string) => void;
  /** Private-file checks for the credential folder; the host default is used when left out. */
  readonly security?: {
    directory(path: string, created?: boolean): void;
    file(path: string): void;
  };
}

export function wireDeviceId(_local: string): string {
  throw new Error("not implemented");
}
export function cloudLoginCatalog(
  base: SurfaceCatalog,
  _deps: CloudLoginDeps,
): SurfaceCatalog {
  return base;
}
