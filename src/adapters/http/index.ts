// Outbound HTTPS to one Forge cloud origin and project, for the device login routes. The origin and
// project are fixed when the client is made; it follows no redirect, sends no bearer token, bounds
// every request by a deadline and every body by a size, and never repeats server text in an error.
import { request } from "node:https";
import { Readable } from "node:stream";
import { ForgeFailure } from "../../contract/failure.ts";

export interface CloudRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
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
}
export interface CloudHttp {
  loginStart(device: string, signal?: AbortSignal): Promise<StartResult>;
  loginPoll(deviceCode: string, signal?: AbortSignal): Promise<PollResult>;
}

type ReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXYZ]{4}-[BCDFGHJKLMNPQRSTVWXYZ]{4}$/;
const MAX_CREDENTIAL = 4_096;
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

const invalid = (message: string): ForgeFailure =>
  new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
const unavailable = (why: string): ForgeFailure =>
  new ForgeFailure({
    code: "UNAVAILABLE",
    message: `The Forge cloud gave no usable answer: ${why}.`,
    retry: "never",
  });
const cancelled = (): ForgeFailure =>
  new ForgeFailure({
    code: "INVOCATION_CANCELLED",
    message: "The login was cancelled.",
    retry: "never",
  });

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
          "content-length": String(Buffer.byteLength(init.body)),
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

export function createCloudHttp(options: CloudHttpOptions): CloudHttp {
  const origin = validateOrigin(options.origin);
  const project = validateProject(options.project);
  const send = options.fetch ?? defaultCloudFetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 65_536;

  async function post(
    route: "loginstart" | "loginpoll",
    body: Readonly<Record<string, string>>,
    caller: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal =
      caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
    try {
      const response = await send(`${origin}/p/${project}/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw unavailable("a redirect was refused");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(response, maxBytes, signal));
      } catch (error) {
        if (error instanceof ForgeFailure) throw error;
        if (signal.aborted) throw error;
        throw unavailable("the answer is not JSON");
      }
      const value = object(parsed);
      if (value === undefined) throw unavailable("the answer is not an object");
      return value;
    } catch (error) {
      if (caller?.aborted === true) throw cancelled();
      if (error instanceof ForgeFailure) throw error;
      throw unavailable(
        deadline.aborted ? "the request timed out" : "the request failed",
      );
    }
  }

  return {
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
  };
}
