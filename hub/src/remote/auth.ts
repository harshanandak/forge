import { createHash, timingSafeEqual } from "node:crypto";
import type { Caller, HostCaller, HubCore } from "../contract/core.ts";
import { HOST_KEY_PATTERN, TOKEN_PATTERN } from "../contract/ids.ts";
import type { HashSecret } from "../contract/runtime.ts";

export type CompareDigest = (presented: Buffer, stored: Buffer) => boolean;
export const hashSecret: HashSecret = (secret) =>
  createHash("sha256").update(secret).digest("hex");

export function authentication(
  core: HubCore,
  compare: CompareDigest = timingSafeEqual,
) {
  const dummy = Buffer.alloc(32, 255);
  const empty = Buffer.alloc(32);
  function lookup<R>(
    request: Request,
    pattern: RegExp,
    find: (hash: string) => R | undefined,
    stored: (row: R) => string,
  ) {
    const header = request.headers.get("authorization") ?? "";
    const value = /^Bearer +(.+)$/i.exec(header)?.[1];
    const hash = value === undefined ? undefined : hashSecret(value);
    const row = hash === undefined ? undefined : find(hash);
    const saved = row === undefined ? "" : stored(row);
    const valid = /^[a-f0-9]{64}$/.test(saved);
    const presented = hash === undefined ? empty : Buffer.from(hash, "hex");
    const equal = compare(presented, valid ? Buffer.from(saved, "hex") : dummy);
    if (equal && valid && value !== undefined && pattern.test(value))
      return row;
  }
  const token = (hash: string) => core.findToken(hash);
  const key = (hash: string) => core.findHostKey(hash);
  return {
    person(request: Request): Caller | undefined {
      const row = lookup(request, TOKEN_PATTERN, token, (row) => row.tokenHash);
      const person = row && core.person(row.personId);
      if (row && person) return { person, tokenId: row.tokenId };
    },
    host(request: Request): HostCaller | undefined {
      const row = lookup(request, HOST_KEY_PATTERN, key, (row) => row.keyHash);
      const person = row && core.person(row.personId);
      if (row && person) return { person, hostInstanceId: row.hostInstanceId };
    },
  };
}
