import type { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import type { ClockPort } from "../../../../src/ports/clock.ts";
import type { IdentityResult } from "../../../../src/ports/identity.ts";

export interface OAuthStorage {
  get<T = string>(key: string, options?: { type: "json" }): Promise<T | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
  }>;
}
export interface OAuthOptions {
  issuer: string;
  resources: readonly string[];
  storage: OAuthStorage;
  clock: ClockPort;
  upstream: {
    begin(state: string): Promise<string>;
    verify(request: Request, now: number): Promise<IdentityResult>;
  };
}
export interface OAuthAdapter {
  register(redirectUri: string): Promise<string>;
  authorize(request: Request): Promise<Response>;
  consent(request: Request, allow: boolean): Promise<Response>;
  callback(request: Request): Promise<Response>;
  token(request: Request): Promise<Response>;
  accepts(
    token: Parameters<OAuthAuthorizationServer["validateToken"]>[1],
    resource: Parameters<OAuthAuthorizationServer["validateToken"]>[0],
  ): Promise<boolean>;
}
