// Shared fixtures for the cloud login tests: a project checkout, a home folder, a fixture clock and a
// scripted network. Nothing here reaches a real network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudFetch } from "../../src/adapters/http/index.ts";
import type {
  CredentialEntry,
  CloudBinding,
} from "../../src/assembly/cloud-profile.ts";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const ORIGIN = "https://forge.example.test";
export const OTHER_ORIGIN = "https://other.example.test";
export const PROJECT = "proj";
export const DEVICE_CODE = "d".repeat(42) + "C";
export const USER_CODE = "BCDF-GHJK";
export const SECRET = "S".repeat(43);
export const DAY = 86_400_000;

export interface Sandbox {
  readonly dir: string;
  readonly root: string;
  readonly home: string;
  readonly deviceRoot: string;
  readonly credentials: string;
  readonly binding: string;
  close(): void;
}
/** A checkout (with a project identity unless told otherwise), a home folder and a device folder. */
export function sandbox(options: { manifest?: boolean } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "forge-cloud-login-"));
  const root = join(dir, "project");
  const home = join(dir, "home");
  const deviceRoot = join(dir, "device");
  mkdirSync(join(root, ".forge"), { recursive: true });
  mkdirSync(home);
  if (options.manifest !== false)
    writeFileSync(
      join(root, ".forge", "project.json"),
      `${JSON.stringify({ schema: 1, id: PROJECT_ID })}\n`,
    );
  return {
    dir,
    root,
    home,
    deviceRoot,
    credentials: join(home, ".forge", "cloud", "credentials.json"),
    binding: join(root, ".forge", "cloud.json"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function clock(start = Date.UTC(2026, 10, 11)) {
  let time = start;
  const waits: number[] = [];
  return {
    now: () => time,
    waits,
    advance(ms: number) {
      time += ms;
    },
    wait(ms: number, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      waits.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}

export function tokenFor(id = "0123456789abcdef", secret = SECRET): string {
  return `fct_${id}.${secret}`;
}
/** The JSON string the Worker returns as `credential`, with expiry relative to the fixture clock. */
export function credentialJson(
  now: number,
  change: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    format: "forge/device-credential/1",
    id: "0123456789abcdef",
    token: tokenFor(),
    device: "dev-1",
    expiresAt: new Date(now + 30 * DAY).toISOString(),
    ...change,
  });
}
export function entry(
  now: number,
  change: Partial<CredentialEntry> = {},
): CredentialEntry {
  return {
    origin: ORIGIN,
    identity: PROJECT_ID,
    project: PROJECT,
    localDevice: "dev-1",
    id: "aaaaaaaaaaaaaaaa",
    token: tokenFor("aaaaaaaaaaaaaaaa", "O".repeat(43)),
    device: "dev-1",
    expiresAt: new Date(now + 30 * DAY).toISOString(),
    ...change,
  };
}
export function bindingFor(change: Partial<CloudBinding> = {}): CloudBinding {
  return {
    schema: 1,
    identity: PROJECT_ID,
    origin: ORIGIN,
    project: PROJECT,
    ...change,
  };
}

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export const startBody = (change: Record<string, unknown> = {}) => ({
  ok: true,
  device_code: DEVICE_CODE,
  user_code: USER_CODE,
  expires_in: 600,
  interval: 5,
  verification_uri: "/device",
  project: PROJECT,
  device: "dev-1",
  ...change,
});
export const pending = () =>
  json({ ok: false, error: "authorization_pending" }, 400);
export const refusal = (error: string, interval?: number, status = 400) =>
  json(
    { ok: false, error, ...(interval === undefined ? {} : { interval }) },
    status,
  );
export const approved = (credential: string) => json({ ok: true, credential });

export interface Call {
  readonly url: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly init: Parameters<CloudFetch>[1];
}
export type Step = (call: Call) => Response | Promise<Response>;
/** Answers the nth request with the nth step (the last step repeats) and records every request. */
export function network(...steps: Step[]) {
  const calls: Call[] = [];
  const fetch: CloudFetch = (url, init) => {
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
    const call = { url, body, headers: init.headers, init };
    calls.push(call);
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (step === undefined) return Promise.reject(new Error("no step"));
    try {
      return Promise.resolve(step(call));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("step"));
    }
  };
  return { calls, fetch };
}
