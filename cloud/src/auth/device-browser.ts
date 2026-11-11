import type { SqlDatabase } from "../../../src/ports/store.ts";
import type { ClerkUpstream } from "../adapters/workers-oauth/clerk/upstream.ts";
import type { CodeRedemption } from "../adapters/workers-oauth/index.ts";
import type { LoginEnv } from "./project-login.ts";

export interface DeviceBrowserOptions {
  db: SqlDatabase;
  env: LoginEnv;
  upstream: ClerkUpstream;
  codeRedemption: CodeRedemption;
  now: () => number;
}

// Tests-first seam. CI must demonstrate the missing browser behaviour before implementation.
export function createDeviceBrowser(_options: DeviceBrowserOptions) {
  return (_request: Request): Promise<Response> =>
    Promise.resolve(
      new Response("Device approval unavailable", { status: 501 }),
    );
}
