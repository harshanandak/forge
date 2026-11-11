// One Durable Object per project: Forge's state owner and lease contract behind four endpoints.
//   POST claim    { subject, holder, ttlMs, requestId }
//   POST renew    { subject, holder, generation, ttlMs, requestId }
//   POST release  { subject, holder, generation, requestId }
//   GET  holder?subject=...
// Request ids: one registry for all routes; a retry never returns a stale lease (see #write).
// The object handles one request at a time and every write below runs without an await, so a
// claim race is decided in arrival order and exactly one caller wins.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type {
  ForgeError,
  LeaseHolder,
  LeaseRecord,
} from "../../src/generated/types.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { validateLeaseHolder } from "../../src/generated/validators.ts";
import {
  clearStaged,
  DUMP_FORMAT,
  dumpOf,
  dumpPage,
  limitsFrom,
  parseDump,
  restoreDump,
  restorePage,
  type Limits,
  type Page,
} from "./dump.ts";
import {
  durableStore,
  PRAGMA_TABLE,
  readOnlyStore,
  type DurableState,
  type DurableStorage,
} from "./store.ts";
import {
  deviceRoute,
  isDeviceCallback,
  isDeviceRoute,
  type DeviceBrowserOptions,
} from "./auth/device-browser.ts";
import {
  isLoginRoute,
  LOGIN,
  LOGIN_MIGRATION,
  loginRoute,
  type LoginEnv,
} from "./auth/project-login.ts";
import {
  commandProject,
  failed,
  MAX_COMMAND_BODY,
  runCommand,
} from "./issue-commands.ts";
import {
  authorize,
  issueToken,
  revokeToken,
  TOKEN_LOOKUP,
  TOKEN_MIGRATION,
  TOKENS,
  tokenParts,
  bearer,
  wellFormed,
} from "./tokens.ts";

const NAMESPACE = "forge/work";
const REQUESTS = "domain_cloud_requests";
const MAX_BODY = 8192;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
// A restore carries a whole project, so its own bound is 8 MiB: far above a device request, and
// about a third of the 128 MB a Worker has to hold the text, parse it and write it. It is enforced
// while the body streams, and over it the request is refused as RESTORE_TOO_LARGE (413).
const MAX_RESTORE_BODY = 8 * 1024 * 1024;
// Set in the object's key-value storage when an admin first issues a token. Until then the object
// runs no SQL at all, so a request that is not authenticated never makes a project database.
const PROVISIONED = "provisioned";
// The next page a paged restore expects. Absent when none is under way. The staged rows sit in the
// project's own tables, but the project is not provisioned until the last page, so no device route
// reads them: every device route stops at "not provisioned" before it runs any SQL.
const STAGED = "restore:next";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Registers the tables this server adds beside the state owner's own. The digest is checked for its
// shape only; the tables hold no Forge state.
const domain = {
  namespace: "forge/cloud",
  reviewedDigest: `sha256:${"0".repeat(64)}`,
  migrations: [
    {
      id: "001_cloud_requests",
      statements: [
        `CREATE TABLE IF NOT EXISTS ${REQUESTS} (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL)`,
      ],
    },
    TOKEN_MIGRATION,
    LOGIN_MIGRATION,
  ],
  tables: [PRAGMA_TABLE, REQUESTS, TOKENS, LOGIN],
};

const fail = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
const STATUS: Record<string, number> = {
  INPUT_INVALID: 400,
  CONTEXT_MISSING: 400,
  NOT_FOUND: 404,
  UNKNOWN_COMMAND: 404,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  INPUT_CONFLICT: 409,
  DUMP_TOO_LARGE: 413,
  DUMP_CHANGED: 409,
  RESTORE_INVALID_ROW: 400,
  RESTORE_TARGET_NOT_EMPTY: 409,
  RESTORE_TOO_LARGE: 413,
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_REVOKED: 401,
  AUTH_EXPIRED: 401,
  AUTH_DEVICE_MISMATCH: 403,
  AUTH_FORBIDDEN: 403,
  AUTH_CONFIG_UNAVAILABLE: 503,
  LEASE_HELD: 409,
  LEASE_STALE: 409,
  LEASE_NOT_HELD: 409,
  LEASE_EXPIRED: 409,
};

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value === "")
    throw fail("INPUT_INVALID", `${key} must be a non-empty string`);
  return value;
}
function integer(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw fail("INPUT_INVALID", `${key} must be a positive safe integer`);
  return value;
}

function optional(input: Record<string, unknown>, key: string): string | null {
  return input[key] === undefined ? null : text(input, key);
}
function object(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fail("INPUT_INVALID", "body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw fail("INPUT_INVALID", "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

// Reads the body up to MAX_BODY bytes and stops there, so a large body is never held in full.
async function bounded(
  request: Request,
  max = MAX_BODY,
  code = "INPUT_INVALID",
): Promise<string> {
  const tooBig = (): ForgeFailure => fail(code, `body is over ${max} bytes`);
  if (Number(request.headers.get("content-length")) > max) throw tooBig();
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = (await reader.read()) as {
      done: boolean;
      value?: Uint8Array;
    };
    const value = chunk.value;
    if (chunk.done || value === undefined) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

// A refusal before the body is read drops the body, so nothing reads the stream after the response.
async function discard(request: Request): Promise<void> {
  const body = request.body;
  if (body !== null && !body.locked && !request.bodyUsed)
    await body.cancel().catch(() => undefined);
}

export class Project {
  readonly #storage: DurableStorage;
  #opened: { db: SqlDatabase; owner: StateOwner } | undefined;
  #provisioned = false;
  readonly #limits: Limits;
  readonly #env: LoginEnv;
  readonly #browser: DeviceBrowserOptions;

  // `env` carries the page and project limits (DUMP_PAGE_BYTES, DUMP_MAX_BYTES); a deploy sets none.
  constructor(
    ctx: DurableState,
    env?: unknown,
    browser: DeviceBrowserOptions = {},
  ) {
    this.#storage = ctx.storage;
    this.#limits = limitsFrom(env);
    this.#env = (env ?? {}) as LoginEnv;
    this.#browser = browser;
  }

  // Forgets a half-finished paged restore: its staged rows and its place in the page order.
  async #abandon(): Promise<void> {
    clearStaged(this.#open().db);
    await this.#storage.delete(STAGED);
  }

  // Creates the schema on first use. Only provisioned projects get here.
  #open(): { db: SqlDatabase; owner: StateOwner } {
    if (this.#opened === undefined) {
      const db = durableStore(this.#storage);
      const owner = new StateOwner(db, { now: () => Date.now() });
      owner.initialize([domain]);
      this.#opened = { db, owner };
    }
    return this.#opened;
  }

  async #isProvisioned(): Promise<boolean> {
    if (!this.#provisioned)
      this.#provisioned = (await this.#storage.get(PROVISIONED)) === true;
    return this.#provisioned;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const route = url.pathname.split("/")[3] ?? "";
      // Login is public: the capability is the device code, and nothing here approves or mints for a caller.
      if (isLoginRoute(request)) {
        if (!(await this.#isProvisioned()))
          throw fail(
            "AUTH_FORBIDDEN",
            "Login is not available for this project",
          );
        return await loginRoute(
          this.#open().db,
          this.#env,
          route as "loginstart" | "loginpoll",
          object(await bounded(request)),
          request.headers.get("CF-Connecting-IP"),
          url.pathname.split("/")[2] ?? "",
        );
      }
      // The owner's browser pages: public, and every decision still needs the Clerk proof of the exact owner.
      if (isDeviceRoute(request) || isDeviceCallback(request)) {
        if (!(await this.#isProvisioned()))
          throw fail(
            "AUTH_FORBIDDEN",
            "Login is not available for this project",
          );
        return await deviceRoute(
          this.#open().db,
          this.#env,
          request,
          typeof this.#env.FORGE_CLOUD_PROJECT === "string"
            ? this.#env.FORGE_CLOUD_PROJECT
            : "",
          this.#browser,
          request.method === "POST" ? await bounded(request, 2048) : "",
        );
      }
      if (commandProject(request) !== undefined)
        return await this.#command(request);
      // The Worker has already checked the admin token before it forwards these two routes.
      if (request.method === "POST" && route === "devices") {
        const input = object(await bounded(request));
        // Issuing a token provisions the project, so staged rows are cleared first: they were never checked.
        if ((await this.#storage.get(STAGED)) !== undefined)
          await this.#abandon();
        await this.#storage.put(PROVISIONED, true);
        this.#provisioned = true;
        const value = await issueToken(
          this.#open().db,
          {
            device: text(input, "device"),
            session: optional(input, "session"),
            agent: optional(input, "agent"),
            harness: optional(input, "harness"),
            ttlMs: integer(input, "ttlMs"),
          },
          Date.now(),
        );
        return Response.json({ ok: true, value });
      }
      if (request.method === "POST" && route === "revoke") {
        const input = object(await bounded(request));
        if (!(await this.#isProvisioned()))
          throw fail("INPUT_INVALID", "No such device token");
        const { db, owner } = this.#open(),
          id = text(input, "id"),
          now = Date.now();
        const value = db.transaction(() => {
          const token = db.get(TOKEN_LOOKUP, [id]);
          const result = revokeToken(db, id, now);
          if (token === undefined || token.revoked_at !== null) return result;
          const released: string[] = [];
          for (const row of db.all(
            "SELECT body FROM state_leases WHERE namespace=? ORDER BY subject",
            [NAMESPACE],
          )) {
            const lease = JSON.parse(String(row.body)) as LeaseRecord;
            const session = lease.holder.session;
            if (
              session.device !== token.device ||
              (token.session !== null && session.id !== token.session) ||
              lease.releasedAt !== undefined ||
              Date.parse(lease.expiresAt) <= now
            )
              continue;
            if (
              db.get(
                `SELECT id FROM ${TOKENS} WHERE device=? AND (session IS NULL OR session=?) AND revoked_at IS NULL AND expires_at>?`,
                [String(token.device), session.id, now],
              ) !== undefined
            )
              continue;
            owner.release(NAMESPACE, {
              subject: lease.subject,
              holder: lease.holder,
              generation: lease.generation,
            });
            released.push(lease.subject);
          }
          return { ...result, released };
        });
        return Response.json({ ok: true, value });
      }
      if (request.method === "GET" && route === "dump") {
        const db = (await this.#isProvisioned()) ? this.#open().db : undefined;
        const cursor = url.searchParams.get("cursor");
        return Response.json({
          ok: true,
          value:
            cursor === null
              ? dumpOf(db, this.#limits)
              : dumpPage(db, cursor, this.#limits),
        });
      }
      if (request.method === "POST" && route === "restore") {
        try {
          return await this.#restore(request);
        } catch (error) {
          // Any refusal of a restore into an unprovisioned project, whatever its cause, ends the session:
          // nothing stays staged. A provisioned project is never touched.
          if (
            !(await this.#isProvisioned()) &&
            (await this.#storage.get(STAGED)) !== undefined
          )
            await this.#abandon();
          throw error;
        }
      }
      if (request.method === "GET" && route === "status")
        return Response.json({
          ok: true,
          value: { initialized: await this.#isProvisioned() },
        });
      const reads = request.method === "GET" && route === "holder";
      const writes =
        request.method === "POST" &&
        (route === "claim" || route === "renew" || route === "release");
      if (!reads && !writes)
        throw fail(
          "UNKNOWN_COMMAND",
          `No route for ${request.method} /${route}`,
        );
      // The device is checked before the body is read, and again right before the write: nothing
      // awaits between that second check and the write, so a revoke cannot land between them.
      // The private binding receives this only after the Worker strips outside headers and authorizes.
      const owner = request.headers.get("X-Forge-Owner");
      const presented = bearer(request);
      if (owner === null && presented === undefined)
        throw fail("AUTH_REQUIRED", "A device token is required");
      const parts = owner === null ? await tokenParts(presented!) : undefined;
      if (parts !== undefined && !(await this.#isProvisioned()))
        throw fail("AUTH_INVALID", "Token is not valid");
      if (parts !== undefined) authorize(this.#open().db, parts, Date.now());
      const body = writes ? await bounded(request) : "";
      if (
        owner !== null &&
        writes &&
        (await this.#storage.get(STAGED)) !== undefined
      )
        throw fail("INPUT_CONFLICT", "An admin restore is under way");
      const device =
        parts === undefined
          ? owner!
          : authorize(this.#open().db, parts, Date.now());
      if (reads) {
        const subject = url.searchParams.get("subject");
        if (subject === null || subject === "")
          throw fail("INPUT_INVALID", "subject is required");
        return Response.json({
          ok: true,
          value: (await this.#isProvisioned())
            ? (this.#open().owner.lease(NAMESPACE, subject) ?? null)
            : null,
        });
      }
      const value = this.#write(
        route as "claim" | "renew" | "release",
        body,
        device,
        owner === null
          ? Number(
              this.#open().db.get(
                `SELECT expires_at FROM ${TOKENS} WHERE id=?`,
                [parts!.id],
              )!.expires_at,
            )
          : Number(request.headers.get("X-Forge-Owner-Expires")),
      );
      if (owner !== null && !this.#provisioned) {
        this.#provisioned = true;
        await this.#storage.put(PROVISIONED, true);
      }
      return Response.json({ ok: true, value });
    } catch (error) {
      await discard(request);
      if (!(error instanceof ForgeFailure)) {
        console.error(error);
        return Response.json(
          {
            ok: false,
            error: { code: "INTERNAL", message: "Server error", retry: "safe" },
          },
          { status: 500 },
        );
      }
      return Response.json(
        { ok: false, error: error.error },
        { status: STATUS[error.error.code] ?? 500 },
      );
    }
  }

  // A typed command, for a device token only: never the owner-forward path, never an admin token.
  // Every refusal is a FAIL envelope. The token is checked before the body is read and again, with
  // no await before the command would run, so a revoke or expiry during the read ends it.
  async #command(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST")
        throw fail(
          "UNKNOWN_COMMAND",
          `No route for ${request.method} /command`,
        );
      if (
        request.headers.has("X-Forge-Owner") ||
        request.headers.has("X-Forge-Owner-Expires") ||
        new URL(request.url).pathname.split("/")[2] !==
          this.#env.FORGE_CLOUD_PROJECT
      )
        throw fail(
          "AUTH_FORBIDDEN",
          "Commands are for a device token on the admitted project",
        );
      const presented = bearer(request);
      if (presented === undefined)
        throw fail("AUTH_REQUIRED", "A device token is required");
      if (!wellFormed(presented))
        throw fail("AUTH_FORBIDDEN", "Commands need a device token");
      const parts = await tokenParts(presented);
      if (!(await this.#isProvisioned()))
        throw fail("AUTH_INVALID", "Token is not valid");
      // Checked through a read-only view: a refusal must not create a table or run a migration.
      // The view runs only the token lookup; nothing from the request names a statement.
      const db = readOnlyStore(this.#storage, TOKENS, [TOKEN_LOOKUP]);
      if (db === undefined) throw fail("AUTH_INVALID", "Token is not valid");
      authorize(db, parts, Date.now());
      const body = await bounded(request, MAX_COMMAND_BODY);
      // No await from here to the response: the second check below stays current while it is built.
      return runCommand(body, {
        device: authorize(db, parts, Date.now()),
        project: commandProject(request)!,
        storage: this.#storage,
        idPrefix: (this.#env as { FORGE_CLOUD_ID_PREFIX?: unknown })
          .FORGE_CLOUD_ID_PREFIX,
        now: Date.now(),
      });
    } catch (error) {
      if (!(error instanceof ForgeFailure)) throw error;
      await discard(request);
      return Response.json(failed(error.error), {
        status: STATUS[error.error.code] ?? 500,
      });
    }
  }

  // One restore request: a whole dump, or one page of a paged restore.
  async #restore(request: Request): Promise<Response> {
    const dump = parseDump(
      await bounded(request, MAX_RESTORE_BODY, "RESTORE_TOO_LARGE"),
    );
    if (await this.#isProvisioned())
      throw new ForgeFailure({
        code: "RESTORE_TARGET_NOT_EMPTY",
        message: "A dump restores only into an empty project",
        retry: "never",
      });
    const staged = (await this.#storage.get(STAGED)) as number | undefined;
    let value: Record<string, unknown>;
    if (dump.format === DUMP_FORMAT) {
      if (staged !== undefined) await this.#abandon();
      value = { restored: restoreDump(this.#open().db, dump) };
    } else {
      const page = dump as Page;
      // Page 0 starts again; any other page must be the one the last accepted page named.
      if (page.page !== 0 && page.page !== staged)
        throw fail(
          "INPUT_INVALID",
          staged === undefined
            ? "No restore is under way: send page 0 first"
            : `Expected page ${staged}, or page 0 to start again`,
        );
      value = {
        restored: restorePage(this.#open().db, page, this.#limits),
        page: page.page,
        done: page.last,
      };
      if (!page.last) {
        await this.#storage.put(STAGED, page.page + 1);
        return Response.json({ ok: true, value });
      }
      await this.#storage.delete(STAGED);
    }
    await this.#storage.put(PROVISIONED, true);
    this.#provisioned = true;
    return Response.json({ ok: true, value });
  }

  #write(
    route: "claim" | "renew" | "release",
    body: string,
    device: string,
    expiresAt?: number,
  ): LeaseRecord {
    const checkExpiry = () => {
      if (expiresAt !== undefined && !(expiresAt > Date.now()))
        throw fail("AUTH_EXPIRED", "Token expired");
    };
    checkExpiry();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw fail("INPUT_INVALID", "body must be JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw fail("INPUT_INVALID", "body must be a JSON object");
    const input = parsed as Record<string, unknown>;
    const subject = text(input, "subject");
    const requestId = text(input, "requestId");
    if (!REQUEST_ID.test(requestId))
      throw fail("INPUT_INVALID", "requestId has an invalid shape");
    const checked = validateLeaseHolder(input.holder);
    if (!checked.ok)
      throw fail(
        "INPUT_INVALID",
        "holder must be { actor: { kind, id }, session: { id, device?, agent?, harness? } }",
      );
    // A device token acts only as its own device: the server sets the holder's device from the token.
    const named = checked.value.session.device;
    if (named !== undefined && named !== device)
      throw fail(
        "AUTH_DEVICE_MISMATCH",
        `Token is for device ${device} but the request names device ${named}`,
      );
    const holder: LeaseHolder = {
      ...checked.value,
      session: { ...checked.value.session, device },
    };
    const ttlMs =
      route === "release" ? null : ((input.ttlMs ?? null) as number);
    const generation = route === "claim" ? null : integer(input, "generation");

    // The one rule for request ids. Every valid write records its id, route and input (keys sorted,
    // as the state owner sorts its own) on first sight, with its outcome, success or refusal.
    // - Another route or input under that id is INPUT_CONFLICT, forever.
    // - A recorded refusal is returned again, never re-run.
    // - A recorded success never returns its old lease: the answer is read from the current lease.
    const fingerprint = canonicalJson({
      route,
      subject,
      holder,
      generation,
      ttlMs,
    });
    const prior = this.#open().db.get(
      `SELECT fingerprint, outcome, result FROM ${REQUESTS} WHERE request_id=?`,
      [requestId],
    );
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint)
        throw new ForgeFailure({
          code: "INPUT_CONFLICT",
          message: "Request ID belongs to a different input",
          retry: "reconcile_first",
        });
      checkExpiry();
      return this.#replay(route, requestId, prior, subject, holder);
    }
    try {
      // The change and its receipt commit together: if the receipt insert fails, the change rolls
      // back, so a retry after the 500 starts from the state the caller last saw.
      return this.#open().db.transaction(() => {
        checkExpiry();
        if (route !== "release") {
          integer(input, "ttlMs");
          if (ttlMs! > MAX_LEASE_MS)
            throw fail("INPUT_INVALID", "ttlMs is over 24 hours");
          if (expiresAt !== undefined && Date.now() + ttlMs! > expiresAt)
            throw fail("INPUT_INVALID", "ttlMs would exceed the token expiry");
        }
        const fence = { subject, holder, generation: generation ?? 0 };
        const lease =
          route === "claim"
            ? this.#open().owner.acquire(
                NAMESPACE,
                subject,
                holder,
                ttlMs!,
                requestId,
              )
            : route === "renew"
              ? this.#open().owner.renew(NAMESPACE, fence, ttlMs!)
              : this.#open().owner.release(NAMESPACE, fence);
        this.#record(requestId, fingerprint, "ok", lease);
        return lease;
      });
    } catch (error) {
      // A refusal changed no lease state (its transaction rolled back), so its receipt is one insert.
      if (
        error instanceof ForgeFailure &&
        (error.error.code.startsWith("LEASE_") ||
          error.error.code === "INPUT_INVALID")
      )
        this.#open().db.transaction(() =>
          this.#record(requestId, fingerprint, error.error.code, error.error),
        );
      throw error;
    }
  }

  #replay(
    route: "claim" | "renew" | "release",
    requestId: string,
    prior: SqlRow,
    subject: string,
    holder: LeaseHolder,
  ): LeaseRecord {
    const recorded = JSON.parse(String(prior.result)) as
      LeaseRecord | ForgeError;
    if (prior.outcome !== "ok") throw new ForgeFailure(recorded as ForgeError);
    const first = recorded as LeaseRecord;
    const current = this.#open().owner.lease(NAMESPACE, subject);
    // A recorded release returns the same released result at any generation: it grants nothing.
    if (route === "release") return first;
    if (
      current !== undefined &&
      decideLease(current, {
        mode: "held",
        subject,
        holder,
        generation: first.generation,
        nowMs: Date.now(),
      }).ok
    )
      return current;
    throw new ForgeFailure({
      code: "LEASE_STALE",
      message: `Request ${requestId} no longer matches the current lease on ${subject}`,
      retry: "reconcile_first",
      lease:
        current === undefined
          ? { subject }
          : {
              subject,
              holder: current.holder,
              generation: current.generation,
              expiresAt: current.expiresAt,
            },
    });
  }

  #record(
    requestId: string,
    fingerprint: string,
    outcome: string,
    result: LeaseRecord | ForgeError,
  ): void {
    this.#open().db.run(
      `INSERT INTO ${REQUESTS} (request_id, fingerprint, outcome, result) VALUES (?, ?, ?, ?)`,
      [requestId, fingerprint, outcome, JSON.stringify(result)],
    );
  }
}
