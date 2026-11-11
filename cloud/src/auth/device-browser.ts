// Owner approval of a device login in the browser. Tests-first stub: the routes are not served yet.
import type { SqlDatabase } from "../../../src/ports/store.ts";
import type { ClerkUpstream } from "../adapters/workers-oauth/clerk/upstream.ts";
import type { CodeRedemption } from "../adapters/workers-oauth/index.ts";
import type { LoginEnv } from "./project-login.ts";

/** Every state this handler issues starts with this; no other OAuth state may. */
export const DEVICE_STATE_PREFIX = "forge-device.";

/** Replaceable parts, so a test can supply the Clerk upstream and the redemption store. */
export interface DeviceBrowserOptions {
  readonly upstream?: ClerkUpstream;
  readonly redemption?: CodeRedemption;
}

export const isDeviceRoute = (_request: Request): boolean => false;
export const isDeviceCallback = (_request: Request): boolean => false;

export function deviceRoute(
  _db: SqlDatabase,
  _env: LoginEnv,
  _request: Request,
  _project: string,
  _options: DeviceBrowserOptions,
): Promise<Response> {
  return Promise.reject(new Error("Device approval is not implemented"));
}
