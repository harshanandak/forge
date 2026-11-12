// Outbound HTTPS to one Forge cloud origin and project: the device login routes and the lease routes.
// It follows no redirect, sends a bearer token only on a lease request and only in the Authorization
// header, bounds every request by a deadline and a size, and never repeats server text or the token.
import { request } from "node:https";
import { Readable } from "node:stream";
import { ForgeFailure } from "../../contract/failure.ts";
import { validateLeaseRecord } from "../../generated/validators.ts";
import {
  conflictOf,
  refusalDetails,
  type RefusalDetails,
} from "./command-refusal.ts";
export type { Blocker, RefusalDetails } from "./command-refusal.ts";
import type {
  AmbientContext,
  LeaseConflict,
  LeaseHolder,
  LeaseRecord,
} from "../../generated/types.ts";

export interface CloudRequestInit {
  readonly method: "POST" | "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}
export type CloudFetch = (
  url: string,
  init: CloudRequestInit,
) => Promise<Response>;

export interface LoginChallenge {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly device: string;
}
export type StartResult =
  | { readonly kind: "started"; readonly challenge: LoginChallenge }
  | {
      readonly kind: "refused";
      readonly error: string;
      readonly interval?: number;
    };
export type PollResult =
  | { readonly kind: "credential"; readonly credential: string }
  | {
      readonly kind: "refused";
      readonly error: string;
      readonly interval?: number;
    };

export interface CloudHttpOptions {
  readonly origin: string;
  readonly project: string;
  readonly fetch?: CloudFetch;
  /** Deadline for one request, headers and body together. */
  readonly timeoutMs?: number;
  /** Largest response body accepted. */
  readonly maxBytes?: number;
  /** Largest command response accepted: the server's 1 MiB show-envelope cap. */
  readonly commandMaxBytes?: number;
}
export type LeaseRoute = "claim" | "renew" | "release";
export interface LeaseWriteBody {
  readonly subject: string;
  readonly holder: LeaseHolder;
  readonly requestId: string;
  readonly ttlMs?: number;
  readonly generation?: number;
}
export type LeaseRefusalCode = keyof typeof REFUSAL_STATUS;
/** A write always carries a lease; a holder read may carry `null`, an expired or a released record. */
export type LeaseResult =
  | { readonly kind: "ok"; readonly lease: LeaseRecord | null }
  | {
      readonly kind: "refused";
      readonly code: LeaseRefusalCode;
      /** Present for the four LEASE_* refusals, with the details the server named. */
      readonly lease?: LeaseConflict;
    };
/** What a typed command sends; the adapter sends exactly these fields. */
export interface CommandWire {
  readonly requestId: string;
  readonly op: string;
  readonly input: unknown;
  readonly context: AmbientContext;
  readonly dryRun?: boolean;
}
export type CommandRefusalCode = keyof typeof COMMAND_STATUS;
export type CommandResult =
  | { readonly kind: "ok"; readonly result: Record<string, unknown> }
  | ({
      readonly kind: "refused";
      readonly code: CommandRefusalCode;
    } & RefusalDetails);
type Answer = { status: number; value: Record<string, unknown> };
export interface CloudHttp {
  /** The validated origin and project every request of this adapter goes to. */
  readonly origin: string;
  readonly project: string;
  loginStart(device: string, signal?: AbortSignal): Promise<StartResult>;
  loginPoll(deviceCode: string, signal?: AbortSignal): Promise<PollResult>;
  leaseWrite(
    token: string,
    route: LeaseRoute,
    body: LeaseWriteBody,
    signal?: AbortSignal,
  ): Promise<LeaseResult>;
  leaseHolder(
    token: string,
    subject: string,
    signal?: AbortSignal,
  ): Promise<LeaseResult>;
  command(
    token: string,
    body: CommandWire,
    signal?: AbortSignal,
  ): Promise<CommandResult>;
}

type ReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXYZ]{4}-[BCDFGHJKLMNPQRSTVWXYZ]{4}$/;
const MAX_CREDENTIAL = 4_096;
const TOKEN = /^fct_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/;
// The refusals a lease route sends, each with the one status the Worker gives it.
const REFUSAL_STATUS = {
  LEASE_HELD: 409,
  LEASE_STALE: 409,
  LEASE_NOT_HELD: 409,
  LEASE_EXPIRED: 409,
  INPUT_CONFLICT: 409,
  INPUT_INVALID: 400,
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_REVOKED: 401,
  AUTH_EXPIRED: 401,
  AUTH_DEVICE_MISMATCH: 403,
} as const;
// The refusals the command route sends, each with the one status the Worker gives it.
const COMMAND_STATUS = {
  INPUT_INVALID: 400,
  CONTEXT_MISSING: 400,
  UNKNOWN_COMMAND: 404,
  NOT_FOUND: 404,
  INPUT_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  LEASE_HELD: 409,
  CLAIM_BLOCKED: 409,
  LEASE_NOT_HELD: 409,
  LEASE_STALE: 409,
  LEASE_EXPIRED: 409,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_REVOKED: 401,
  AUTH_EXPIRED: 401,
  AUTH_DEVICE_MISMATCH: 403,
  AUTH_FORBIDDEN: 403,
} as const;
/** Refusal names the Worker is known to send; any other name is reported as "unknown". */
const REFUSALS = new Set([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
  "invalid_user_code",
  "rate_limited",
  "capacity_exceeded",
  "issuance_failed",
  "unavailable",
  "AUTH_FORBIDDEN",
  "AUTH_CONFIG_UNAVAILABLE",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "INPUT_INVALID",
  "UNKNOWN_COMMAND",
]);

// The failures this adapter made itself. A ForgeFailure from anywhere else, such as the transport
// or its stream, is not passed on: its text could hold the bearer token.
const own = new WeakSet<ForgeFailure>();
const mine = (failure: ForgeFailure): ForgeFailure => (
  own.add(failure),
  failure
);
const invalid = (message: string): ForgeFailure =>
  mine(new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" }));
const unavailable = (why: string): ForgeFailure =>
  mine(
    new ForgeFailure({
      code: "UNAVAILABLE",
      message: `The Forge cloud gave no usable answer: ${why}.`,
      retry: "never",
    }),
  );
const cancelled = (): ForgeFailure =>
  mine(
    new ForgeFailure({
      code: "INVOCATION_CANCELLED",
      message: "The request was cancelled.",
      retry: "never",
    }),
  );

/** An HTTPS origin and nothing else: no credentials, path, query or fragment, and already canonical. */
export function validateOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw invalid("origin must be an HTTPS origin such as https://host");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== origin
  )
    throw invalid(
      "origin must be an HTTPS origin with no credentials, path, query or fragment",
    );
  return origin;
}

/** The Worker's route grammar for a project name. */
export function validateProject(project: string): string {
  if (!PROJECT.test(project))
    throw invalid(
      "project must be 1 to 64 letters, digits, dots, hyphens or underscores, starting with a letter or digit",
    );
  return project;
}

/** Node's https module never follows a redirect, so a 3xx arrives as an ordinary response. */
export const defaultCloudFetch: CloudFetch = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method,
        headers: {
          ...init.headers,
          ...(init.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(init.body)) }),
        },
        signal: init.signal,
        agent: false,
      },
      (res) => {
        try {
          const status = res.statusCode ?? 0;
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers))
            if (value !== undefined)
              headers.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
          if (status === 204 || status === 205 || status === 304) {
            res.resume();
            resolve(new Response(null, { status, headers }));
          } else
            resolve(new Response(Readable.toWeb(res), { status, headers }));
        } catch (error) {
          res.destroy();
          reject(error instanceof Error ? error : new Error("response"));
        }
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });

/** Reads at most `max` bytes, giving up at the signal, and cancels the stream however it ends. */
async function readBody(
  response: Response,
  max: number,
  signal: AbortSignal,
): Promise<string> {
  if (Number(response.headers.get("content-length")) > max) {
    void response.body?.cancel().catch(() => undefined);
    throw unavailable("the response is too large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const stop = new Promise<never>((_, reject) => {
    const on = () => reject(new Error("aborted"));
    if (signal.aborted) on();
    else signal.addEventListener("abort", on, { once: true });
  });
  stop.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk: ReadResult = await Promise.race([reader.read(), stop]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > max) throw unavailable("the response is too large");
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unavailable("the response is not text");
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const integer = (
  value: unknown,
  min: number,
  max: number,
): number | undefined =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max
    ? value
    : undefined;

/** A refusal's name from the fixed vocabulary, and its interval when it is a sane one. */
function refusal(body: Record<string, unknown>) {
  const error = body.error;
  const name = typeof error === "string" ? error : object(error)?.code;
  if (typeof name !== "string")
    throw unavailable("the answer has no known shape");
  const interval = integer(body.interval, 1, 300);
  return {
    kind: "refused" as const,
    error: REFUSALS.has(name) ? name : "unknown",
    ...(interval === undefined ? {} : { interval }),
  };
}

/** A lease route's `{ ok, value }` or `{ ok, error }` envelope; anything that contradicts itself is unavailable. */
function decodeLease(
  { status, value: body }: Answer,
  subject: string,
  writes: boolean,
): LeaseResult {
  const bad = () => unavailable("the lease answer failed its checks");
  // Exactly { ok, value } or { ok, error }: an envelope that carries both is contradictory.
  const keys = Object.keys(body).sort().join();
  if (keys !== (body.ok === true ? "ok,value" : "error,ok")) throw bad();
  if (body.ok === true) {
    if (status !== 200) throw bad();
    if (body.value === null && !writes) return { kind: "ok", lease: null };
    const checked = validateLeaseRecord(body.value);
    if (!checked.ok || checked.value.subject !== subject) throw bad();
    return { kind: "ok", lease: checked.value };
  }
  const error = object(body.error);
  const code = error?.code as LeaseRefusalCode;
  if (
    body.ok !== false ||
    typeof code !== "string" ||
    !Object.hasOwn(REFUSAL_STATUS, code) ||
    REFUSAL_STATUS[code] !== status
  )
    throw bad();
  if (!code.startsWith("LEASE_")) return { kind: "refused", code };
  const lease = conflictOf(error?.lease, subject);
  if (lease === undefined) throw bad();
  return { kind: "refused", code, lease };
}

/** A command answer: exactly { ok, op, status, result, warnings } or { ok, status, error, warnings }. Only the result, or the error code with its checked details, is kept. */
function decodeCommand(
  { status, value: body }: Answer,
  call: CommandWire,
  token: string,
): CommandResult {
  const { op } = call;
  const bad = () => unavailable("the command answer failed its checks");
  const keys = Object.keys(body).sort().join();
  const result = object(body.result);
  if (body.ok === true) {
    if (status !== 200 || keys !== "ok,op,result,status,warnings") throw bad();
    if (body.op !== op || body.status !== "OK" || result === undefined)
      throw bad();
    if (!Array.isArray(body.warnings)) throw bad();
    return { kind: "ok", result };
  }
  const code = object(body.error)?.code as CommandRefusalCode;
  if (
    body.ok !== false ||
    keys !== "error,ok,status,warnings" ||
    body.status !== "FAIL" ||
    !Array.isArray(body.warnings) ||
    typeof code !== "string" ||
    !Object.hasOwn(COMMAND_STATUS, code) ||
    COMMAND_STATUS[code] !== status
  )
    throw bad();
  const details = refusalDetails(code, call, object(body.error) ?? {}, token);
  if (details === undefined) throw bad();
  return { kind: "refused", code, ...details };
}

export function createCloudHttp(options: CloudHttpOptions): CloudHttp {
  const origin = validateOrigin(options.origin);
  const project = validateProject(options.project);
  const send = options.fetch ?? defaultCloudFetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 65_536;
  const commandMax = options.commandMaxBytes ?? 1_048_576;

  async function exchange(
    method: "POST" | "GET",
    path: string,
    body: string | undefined,
    token: string | undefined,
    caller: AbortSignal | undefined,
    limit = maxBytes,
  ): Promise<Answer> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal =
      caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
    try {
      const response = await send(`${origin}/p/${project}/${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw unavailable("a redirect was refused");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(response, limit, signal));
      } catch (error) {
        if (error instanceof ForgeFailure) throw error;
        if (signal.aborted) throw error;
        throw unavailable("the answer is not JSON");
      }
      const value = object(parsed);
      if (value === undefined) throw unavailable("the answer is not an object");
      return { status: response.status, value };
    } catch (error) {
      if (caller?.aborted === true) throw cancelled();
      if (error instanceof ForgeFailure && own.has(error)) throw error;
      throw unavailable(
        deadline.aborted ? "the request timed out" : "the request failed",
      );
    }
  }
  const post = async (
    route: "loginstart" | "loginpoll",
    body: Readonly<Record<string, string>>,
    caller: AbortSignal | undefined,
  ) =>
    (await exchange("POST", route, JSON.stringify(body), undefined, caller))
      .value;
  async function lease(
    token: string,
    path: string,
    body: string | undefined,
    subject: string,
    caller: AbortSignal | undefined,
  ): Promise<LeaseResult> {
    if (!TOKEN.test(token))
      throw invalid("the device token is not well formed");
    const method = body === undefined ? "GET" : "POST";
    const answer = await exchange(method, path, body, token, caller);
    return decodeLease(answer, subject, body !== undefined);
  }

  return {
    origin,
    project,
    async loginStart(device, signal) {
      const body = await post("loginstart", { device }, signal);
      if (body.ok !== true) return refusal(body);
      const challenge = {
        deviceCode: body.device_code,
        userCode: body.user_code,
        expiresIn: integer(body.expires_in, 1, 3_600),
        interval: integer(body.interval, 1, 300),
        device: body.device,
      };
      if (
        typeof challenge.deviceCode !== "string" ||
        !DEVICE_CODE.test(challenge.deviceCode) ||
        typeof challenge.userCode !== "string" ||
        !USER_CODE.test(challenge.userCode) ||
        challenge.expiresIn === undefined ||
        challenge.interval === undefined ||
        body.verification_uri !== "/device" ||
        body.project !== project ||
        challenge.device !== device
      )
        throw unavailable("the login answer failed its checks");
      return {
        kind: "started",
        challenge: {
          deviceCode: challenge.deviceCode,
          userCode: challenge.userCode,
          expiresIn: challenge.expiresIn,
          interval: challenge.interval,
          device,
        },
      };
    },
    async loginPoll(deviceCode, signal) {
      const body = await post("loginpoll", { device_code: deviceCode }, signal);
      if (body.ok !== true) return refusal(body);
      if (
        typeof body.credential !== "string" ||
        body.credential.length > MAX_CREDENTIAL
      )
        throw unavailable("the login answer failed its checks");
      return { kind: "credential", credential: body.credential };
    },
    leaseWrite: (token, route, body, signal) =>
      lease(token, route, JSON.stringify(body), body.subject, signal),
    leaseHolder: (token, subject, signal) =>
      lease(
        token,
        `holder?subject=${encodeURIComponent(subject)}`,
        undefined,
        subject,
        signal,
      ),
    async command(token, body, signal) {
      if (!TOKEN.test(token))
        throw invalid("the device token is not well formed");
      const wire = JSON.stringify(body);
      const answer = await exchange(
        "POST",
        "command",
        wire,
        token,
        signal,
        commandMax,
      );
      return decodeCommand(answer, body, token);
    },
  };
}
