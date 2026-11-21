// One Durable Object per project: Forge's state owner and lease contract behind four endpoints.
//   POST claim    { subject, holder, ttlMs, requestId }
//   POST renew    { subject, holder, generation, ttlMs, requestId }
//   POST release  { subject, holder, generation, requestId }
//   GET  holder?subject=...
// Request ids: one registry for all routes; a retry never returns a stale lease (see #write).
// The object handles one request at a time and every write below runs without an await, so a
// claim race is decided in arrival order and exactly one caller wins.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { storageFailure } from "./storage-failure.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import {
  StateOwner,
  WATERMARK_INDEX_PROBE,
} from "../../src/core/state/index.ts";
import type {
  ForgeError,
  LeaseHolder,
  LeaseRecord,
} from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { validateLeaseHolder } from "../../src/generated/validators.ts";
import {
  assertRestoreCompatible,
  clearStaged,
  DUMP_FORMAT,
  DUMP_MIGRATION,
  IMPORT_MIGRATION,
  RETENTION_MIGRATION,
  REQUEST_AGE_DUMP_MIGRATION,
  CLOUD_USAGE_COLUMNS,
  COMMAND_RECEIPTS,
  EXPORT_STATE,
  dumpOf,
  dumpPage,
  dumpUsage,
  dumpStore,
  DUMP_USAGE_READS,
  limitsFrom,
  parseDump,
  restoreDump,
  restorePage,
  type Limits,
  type Page,
} from "./dump.ts";
import {
  initializePragma,
  writableStore,
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
  LIMITS,
  LIMITS_MIGRATION,
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
  guardLegacy,
  receiptScope,
  scopeRequestId,
  type ReceiptPrincipal,
} from "./issue-request-id.ts";
import { checkTtl } from "./lease-ttl.ts";
import {
  type LeaseCommand,
  leaseFingerprint,
  NAMESPACE,
  recordable,
  replayLease,
  requestConflict,
} from "./lease-command.ts";
import {
  expiredReplay,
  RETENTION_MS,
  PRUNE_RECEIPTS,
  withDenialCapacity,
  maintainReceipts,
  receiptMaintenanceDeadline,
} from "./issue-receipts.ts";
import { EVIDENCE_MIGRATION, EVIDENCE_RECEIPTS } from "./evidence-receipts.ts";
import { LaneControlStore } from "./lane-control-store.ts";
import { LANE_APPROVALS, LANE_APPROVAL_MIGRATION } from "./lane-approval.ts";
import { ISSUE_INDEX, ISSUE_INDEX_MIGRATION } from "./issue-index.ts";
import {
  isLaneCallback,
  isLaneRoute,
  laneRoute,
  LANE_BROWSER,
  LANE_BROWSER_MIGRATION,
} from "./auth/lane-browser.ts";
import { requireTokenSession } from "./token-session.ts";
import { admitState, isStatePath, stateRoute } from "./state-access.ts";
import { parseStateInput } from "./state-input.ts";
import { readState, STATE_EPOCH } from "./state-read.ts";
import { commitState } from "./state-commit.ts";
import {
  authorize,
  authorizeToken,
  issueToken,
  revokeToken,
  TOKEN_LOOKUP,
  MAX_TTL_MS,
  TOKEN_MIGRATION,
  TOKENS,
  tokenParts,
  bearer,
  wellFormed,
} from "./tokens.ts";

import { stateMigrations } from "../../src/core/state/migrations.ts";
import {
  appendV3Frames,
  hasV3Root,
  leaseV3,
  provisionV3,
  publishV3,
  recoverV3,
  requireGenesisForLease,
  type V3Image,
  viewV3,
} from "./v3-store.ts";

const REQUESTS = "domain_cloud_requests";
const MAX_BODY = 8192;
// A restore carries a whole project, so its own bound is 8 MiB: far above a device request, and
// about a third of the 128 MB a Worker has to hold the text, parse it and write it. It is enforced
// while the body streams, and over it the request is refused as RESTORE_TOO_LARGE (413).
const MAX_RESTORE_BODY = 8 * 1024 * 1024;
// Set in the object's key-value storage when an admin first issues a token. Until then the object
// runs no SQL at all, so a request that is not authenticated never makes a project database.
const PROVISIONED = "provisioned";
// The next page and original format share one persisted checkpoint, absent outside a restore.
// Staged rows sit in the project's tables, but no device route reads them before the last page:
// every device route stops at "not provisioned" before it runs any SQL.
const STAGED = "restore:next";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// StateOwner.lease's own statement, the only one the holder view may run.
const LEASE_SELECT =
  "SELECT body FROM state_leases WHERE namespace=? AND subject=?";

// Registers the tables this server adds beside the state owner's own. The digest is checked for its
// shape only; the tables hold no Forge state.
export const domain = {
  namespace: "forge/cloud",
  reviewedDigest: `sha256:${"0".repeat(64)}`,
  usage: CLOUD_USAGE_COLUMNS,
  migrations: [
    {
      id: "001_cloud_requests",
      statements: [
        `CREATE TABLE IF NOT EXISTS ${REQUESTS} (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL)`,
      ],
    },
    TOKEN_MIGRATION,
    LOGIN_MIGRATION,
    LIMITS_MIGRATION,
    DUMP_MIGRATION,
    IMPORT_MIGRATION,
    LANE_APPROVAL_MIGRATION,
    EVIDENCE_MIGRATION,
    LANE_BROWSER_MIGRATION,
    RETENTION_MIGRATION,
    REQUEST_AGE_DUMP_MIGRATION,
    ISSUE_INDEX_MIGRATION,
  ],
  tables: [
    PRAGMA_TABLE,
    REQUESTS,
    TOKENS,
    LOGIN,
    LIMITS,
    COMMAND_RECEIPTS,
    EXPORT_STATE,
    LANE_APPROVALS,
    EVIDENCE_RECEIPTS,
    LANE_BROWSER,
    ISSUE_INDEX,
  ],
};

const fail = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
const tokenLive = (expiresAt?: number): void => {
  if (!Number.isSafeInteger(expiresAt) || !(Number(expiresAt) > Date.now()))
    throw fail("AUTH_EXPIRED", "Token expired");
};
export const STATUS: Record<string, number> = {
  INPUT_INVALID: 400,
  CONTEXT_MISSING: 400,
  NOT_FOUND: 404,
  UNKNOWN_COMMAND: 404,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  QUOTA_EXHAUSTED: 503,
  STORAGE_LIMIT_EXCEEDED: 503,
  INPUT_CONFLICT: 409,
  APPROVAL_REQUIRED: 409,
  REVISION_CONFLICT: 409,
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
  RECEIPT_REQUIRED: 400,
  RECEIPT_INVALID: 400,
  RECEIPT_HEAD_MISMATCH: 409,
  PR_NOT_MERGED: 409,
  CLAIM_BLOCKED: 409,
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
  strictUtf8 = false,
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
  const bytes = await new Blob(chunks).arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: strictUtf8 }).decode(bytes);
  } catch {
    throw fail("INPUT_INVALID", "body must be valid UTF-8");
  }
}

// A refusal before the body is read drops the body, so nothing reads the stream after the response.
async function discard(request: Request): Promise<void> {
  const body = request.body;
  if (body !== null && !body.locked && !request.bodyUsed)
    await body.cancel().catch(() => undefined);
}

export interface UpgradeReadiness {
  readonly ready: boolean;
  readonly index: boolean;
  readonly pending: readonly string[];
}

/** Validate before the Worker resolves a Project; repeat at the private object boundary. */
export async function validateUpgrade(request: Request): Promise<void> {
  if (
    new URL(request.url).search !== "" ||
    !["GET", "POST"].includes(request.method)
  )
    throw fail(
      "INPUT_INVALID",
      "Upgrade requires GET or POST without query parameters",
    );
  if (
    request.method === "POST" &&
    Object.keys(object(await bounded(request, 64, "INPUT_INVALID", true)))
      .length !== 0
  )
    throw fail("INPUT_INVALID", "Upgrade body must be an empty JSON object");
}

export class Project {
  readonly #storage: DurableStorage;
  #opened: { db: SqlDatabase; owner: StateOwner } | undefined;
  #initialized = false;
  #provisioned = false;
  #v3Root: boolean | undefined;
  #v3Image: V3Image | undefined;
  #maintenanceAt: number | undefined;
  readonly #limits: Limits;
  readonly #env: LoginEnv;
  readonly #browser: DeviceBrowserOptions;
  readonly #testV3: boolean;

  // The existing parser resolves DUMP_PAGE_BYTES, DUMP_MAX_ROWS and DUMP_MAX_BYTES once.
  constructor(
    ctx: DurableState,
    env?: unknown,
    browser: DeviceBrowserOptions = {},
  ) {
    this.#storage = ctx.storage;
    this.#limits = limitsFrom(env);
    this.#env = (env ?? {}) as LoginEnv;
    this.#browser = browser;
    this.#testV3 = ctx.testV3 === true;
  }

  async alarm(): Promise<void> {
    if (this.#hasV3Root()) return;
    this.#maintenanceAt = undefined;
    if (!(await this.#isProvisioned())) return;
    const { db } = this.#openWrite();
    maintainReceipts(db, Date.now());
    const next = receiptMaintenanceDeadline(db);
    if (next !== undefined)
      await this.#armMaintenance(Math.max(Date.now() + 1, next));
  }

  async #armMaintenance(time: number): Promise<void> {
    if (!this.#storage.setAlarm) return;
    if (this.#maintenanceAt === undefined) {
      const existing = await this.#storage.getAlarm?.();
      this.#maintenanceAt = Math.min(
        this.#maintenanceAt ?? Infinity,
        existing ?? Infinity,
      );
    }
    if (time < this.#maintenanceAt) {
      this.#requireV2();
      this.#maintenanceAt = time;
      try {
        await this.#storage.setAlarm(time);
      } catch (error) {
        this.#maintenanceAt = undefined;
        throw error;
      }
    }
  }

  #hasV3Root(): boolean {
    return (this.#v3Root ??= hasV3Root(writableStore(this.#storage)));
  }

  #image(db: SqlDatabase): V3Image {
    if (this.#v3Image === undefined || this.#v3Image.stale)
      this.#v3Image = recoverV3(db);
    return this.#v3Image;
  }

  #requireV2(): void {
    if (this.#hasV3Root())
      throw fail("INPUT_CONFLICT", "Cloud v3 projects cannot use v2 routes");
  }

  // Forgets a half-finished paged restore: its staged rows and its place in the page order.
  async #abandon(): Promise<void> {
    clearStaged(this.#open().db);
    await this.#storage.delete(STAGED);
  }

  // A cached public handle must not suppress later admitted initialization.
  #open(): { db: SqlDatabase; owner: StateOwner } {
    if (this.#opened === undefined) {
      const db = writableStore(this.#storage);
      const owner = new StateOwner(db, { now: () => Date.now() });
      this.#opened = { db, owner };
    }
    return this.#opened;
  }

  #openWrite(stagedRestore = false): { db: SqlDatabase; owner: StateOwner } {
    this.#requireV2();
    const opened = this.#open();
    if (!this.#initialized) {
      opened.db.transaction(() => {
        initializePragma(this.#storage);
        opened.owner.initialize([domain], stagedRestore);
      });
      this.#initialized = true;
    }
    return opened;
  }

  #public(...tables: string[]): { db: SqlDatabase; owner: StateOwner } {
    for (const table of tables)
      if (readOnlyStore(this.#storage, table, []) === undefined)
        throw fail("UNAVAILABLE", "Project maintenance is required");
    return this.#open();
  }

  async #isProvisioned(): Promise<boolean> {
    if (!this.#provisioned)
      this.#provisioned = (await this.#storage.get(PROVISIONED)) === true;
    return this.#provisioned;
  }

  #readiness(): UpgradeReadiness {
    const ledger = "SELECT id FROM state_migrations ORDER BY id";
    const version = `SELECT value FROM ${PRAGMA_TABLE} WHERE name='user_version'`;
    const db = readOnlyStore(this.#storage, "state_migrations", [
      ledger,
      version,
      WATERMARK_INDEX_PROBE,
    ]);
    if (
      !db ||
      !readOnlyStore(this.#storage, PRAGMA_TABLE, []) ||
      db.get(version)?.value !== 0
    )
      throw fail("INPUT_CONFLICT", "Project schema is not compatible");
    const known = [...stateMigrations, ...domain.migrations].map((m) => m.id);
    const applied = new Set(db.all(ledger).map((row) => String(row.id)));
    const index = db.get(WATERMARK_INDEX_PROBE) !== undefined;
    if (
      [...applied].some((id) => !known.includes(id)) ||
      (applied.has("005_state_events_namespace_index") && !index)
    )
      throw fail("INPUT_CONFLICT", "Project schema is not compatible");
    const pending = known.filter((id) => !applied.has(id));
    return { ready: index && pending.length === 0, index, pending };
  }

  // The stored lease as is, read through a view of the lease table: a read never sets up storage, and no table is no lease.
  async #holder(subject: string): Promise<LeaseRecord | undefined> {
    if (!(await this.#isProvisioned())) return undefined;
    const db = readOnlyStore(this.#storage, "state_leases", [LEASE_SELECT]);
    return db === undefined
      ? undefined
      : new StateOwner(db, { now: () => Date.now() }).lease(NAMESPACE, subject);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const route = url.pathname.split("/")[3] ?? "";
      const probe =
        this.#testV3 &&
        /^\/p\/[^/]+\/test-v3(?:\/(commits|claim|renew|release))?$/.exec(
          url.pathname,
        );
      if (probe && !url.search) {
        const db = writableStore(this.#storage);
        if (!probe[1] && request.method === "GET")
          return Response.json({ ok: true, value: viewV3(this.#image(db)) });
        if (request.method === "POST") {
          const lease = probe[1] !== "commits" && probe[1];
          const owner = request.headers.get("X-Forge-Owner");
          if (lease && owner === null)
            throw fail("AUTH_REQUIRED", "A device token is required");
          const body = await bounded(request);
          if (lease && owner !== null) {
            const expiresAt = Number(
              request.headers.get("X-Forge-Owner-Expires"),
            );
            tokenLive(expiresAt);
            const command = this.#admit(
              probe[1] as "claim" | "renew" | "release",
              body,
              owner,
              null,
              ["owner", owner, owner],
            );
            const image = this.#image(db);
            requireGenesisForLease(image);
            const value = leaseV3(db, image, command, expiresAt);
            return Response.json({ ok: true, value });
          }
          const input = object(body);
          if (probe[1]) {
            const value = appendV3Frames(db, input.frames, () =>
              this.#image(db),
            );
            publishV3(this.#v3Image!);
            return Response.json({ ok: true, value });
          }
          if (Object.keys(input).length)
            throw fail("INPUT_INVALID", "Expected an empty provision body");
          const legacy =
            (await this.#storage.get(PROVISIONED)) !== undefined ||
            (await this.#storage.get(STAGED)) !== undefined;
          this.#v3Image = provisionV3(db, legacy);
          this.#v3Root = true;
          return Response.json({ ok: true, value: viewV3(this.#v3Image) });
        }
      }
      if (route === "upgrade" || route === "devices" || route === "restore")
        this.#requireV2();
      if (isStatePath(request)) return await this.#state(request);
      if (route === "upgrade") {
        await validateUpgrade(request);
        if (!(await this.#isProvisioned()))
          throw fail(
            "INPUT_CONFLICT",
            "Upgrade requires a provisioned project",
          );
        const before = this.#readiness();
        if (request.method === "GET")
          return Response.json({ ok: true, value: before });
        if (!before.ready) this.#openWrite();
        const readiness = this.#readiness();
        return Response.json({
          ok: true,
          value: {
            ...readiness,
            outcome: before.ready ? "already ready" : "upgraded",
          },
        });
      }
      // Login is public: the capability is the device code, and nothing here approves or mints for a caller.
      if (isLoginRoute(request)) {
        if (!(await this.#isProvisioned()))
          throw fail(
            "AUTH_FORBIDDEN",
            "Login is not available for this project",
          );
        const input = object(await bounded(request));
        return await loginRoute(
          this.#public(LOGIN).db,
          this.#env,
          route as "loginstart" | "loginpoll",
          input,
          request.headers.get("CF-Connecting-IP"),
          url.pathname.split("/")[2] ?? "",
        );
      }
      if (isLaneRoute(request) || isLaneCallback(request)) {
        if (!(await this.#isProvisioned()))
          throw fail(
            "AUTH_FORBIDDEN",
            "Lane approval is not available for this project",
          );
        return await laneRoute(
          this.#storage,
          () => this.#public(LANE_BROWSER, LANE_APPROVALS),
          this.#env,
          request,
          this.#browser,
          request.method === "POST" ? await bounded(request, 2048) : "",
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
          (request.method === "GET" && url.pathname === "/device"
            ? this.#open()
            : this.#public(LOGIN, LIMITS)
          ).db,
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
        const deviceInput = {
          device: text(input, "device"),
          session: optional(input, "session"),
          agent: optional(input, "agent"),
          harness: optional(input, "harness"),
          ttlMs: integer(input, "ttlMs"),
        };
        if (deviceInput.ttlMs > MAX_TTL_MS)
          throw fail("INPUT_INVALID", "ttlMs is over 90 days");
        // Issuing a token provisions the project, so staged rows are cleared first: they were never checked.
        if ((await this.#storage.get(STAGED)) !== undefined)
          await this.#abandon();
        const db = this.#openWrite().db;
        const epoch = await this.#storage.get(STATE_EPOCH);
        if (typeof epoch !== "string" || epoch.length === 0)
          await this.#storage.put(STATE_EPOCH, crypto.randomUUID());
        await this.#storage.put(PROVISIONED, true);
        this.#provisioned = true;
        const value = await issueToken(db, deviceInput, Date.now());
        return Response.json({ ok: true, value });
      }
      if (request.method === "POST" && route === "revoke") {
        const input = object(await bounded(request));
        if (!(await this.#isProvisioned()))
          throw fail("INPUT_INVALID", "No such device token");
        const id = text(input, "id");
        const { db, owner } = this.#openWrite(),
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
        const db = (await this.#isProvisioned())
          ? dumpStore(this.#storage)
          : undefined;
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
        // Compatibility refusal precedes both restore writes and the refusal cleanup.
        if (!(await this.#isProvisioned()))
          assertRestoreCompatible(this.#storage);
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
      if (request.method === "GET" && route === "status") {
        try {
          const initialized = await this.#isProvisioned();
          const db = initialized
            ? readOnlyStore(this.#storage, "state_records", DUMP_USAGE_READS)
            : undefined;
          if (initialized && db === undefined)
            throw new Error("Missing dump tables");
          return Response.json({
            ok: true,
            value: { initialized, dump: dumpUsage(db, this.#limits, true) },
          });
        } catch (error) {
          const refusal = storageFailure(error);
          if (refusal) throw refusal;
          const missing =
            error instanceof Error &&
            /no such table|^Missing dump tables$/i.test(error.message);
          throw fail(
            "UNAVAILABLE",
            missing
              ? "Dump usage is unavailable; upgrade the project with POST /p/<project>/upgrade"
              : "Dump usage is unavailable",
          );
        }
      }
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
      // Checked through a read-only view of the token table: a refused token must not set up or migrate storage.
      const view =
        parts === undefined
          ? undefined
          : readOnlyStore(this.#storage, TOKENS, [TOKEN_LOOKUP]);
      if (parts !== undefined) {
        if (view === undefined)
          throw fail("AUTH_INVALID", "Token is not valid");
        authorize(view, parts, Date.now());
      }
      const body = writes ? await bounded(request) : "";
      let requireArm = () => {};
      if (writes)
        try {
          await this.#armMaintenance(
            Math.min(
              Date.now() + RETENTION_MS,
              parts === undefined
                ? Number(request.headers.get("X-Forge-Owner-Expires"))
                : authorizeToken(view!, parts, Date.now()).expiresAt,
            ),
          );
        } catch (error) {
          requireArm = () => {
            throw error;
          };
        }
      if (
        owner !== null &&
        writes &&
        (await this.#storage.get(STAGED)) !== undefined
      )
        throw fail("INPUT_CONFLICT", "An admin restore is under way");
      const token =
        parts === undefined
          ? undefined
          : authorizeToken(view!, parts, Date.now());
      const device = token?.device ?? owner!;
      if (reads) {
        const subject = url.searchParams.get("subject");
        if (subject === null || subject === "")
          throw fail("INPUT_INVALID", "subject is required");
        return Response.json({
          ok: true,
          value: (await this.#holder(subject)) ?? null,
        });
      }
      // Nothing awaits between the check above and the first writable opening in #write.
      const value = this.#write(
        route as "claim" | "renew" | "release",
        body,
        device,
        token?.session ?? null,
        token === undefined
          ? ["owner", owner!, device]
          : ["token", token.id, device],
        () => {
          if (parts !== undefined) authorize(view!, parts, Date.now());
        },
        requireArm,
        token?.expiresAt ??
          Number(request.headers.get("X-Forge-Owner-Expires")),
      );
      if (owner !== null && !this.#provisioned) {
        this.#provisioned = true;
        await this.#storage.put(PROVISIONED, true);
      }
      return Response.json({ ok: true, value });
    } catch (caught) {
      const error = storageFailure(caught) ?? caught;
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

  async #state(request: Request): Promise<Response> {
    try {
      const route = stateRoute(request);
      if (route === undefined || request.method !== "POST")
        throw fail("UNKNOWN_COMMAND", "No such state route");
      if (
        route.project !== this.#env.FORGE_CLOUD_PROJECT ||
        request.headers.has("X-Forge-Owner") ||
        request.headers.has("X-Forge-Owner-Expires")
      )
        throw fail(
          "AUTH_FORBIDDEN",
          "State routes need a device token on the admitted project",
        );
      const presented = bearer(request);
      if (presented === undefined)
        throw fail("AUTH_REQUIRED", "A device token is required");
      if (!wellFormed(presented))
        throw fail("AUTH_FORBIDDEN", "State routes need a device token");
      const parts = await tokenParts(presented);
      if (!(await this.#isProvisioned()))
        throw fail("AUTH_INVALID", "Token is not valid");
      const db = readOnlyStore(this.#storage, TOKENS, [TOKEN_LOOKUP]);
      if (db === undefined) throw fail("AUTH_INVALID", "Token is not valid");
      authorizeToken(db, parts, Date.now());
      const body = await bounded(
        request,
        MAX_COMMAND_BODY,
        "INPUT_INVALID",
        true,
      );
      // Recheck after the stream; no writable owner is opened by admission.
      const token = authorizeToken(db, parts, Date.now());
      const input = parseStateInput(body);
      if (input.kind !== route.kind)
        throw fail("INPUT_INVALID", "State route and kind must agree");
      const admission = admitState(
        input,
        { ...token, project: route.project },
        (this.#env as { FORGE_STATE_NAMESPACES?: unknown })
          .FORGE_STATE_NAMESPACES,
      );
      if (input.kind === "read") {
        const epoch = await this.#storage.get(STATE_EPOCH);
        authorizeToken(db, parts, Date.now());
        return readState(
          this.#storage,
          input,
          route.project,
          admission.policyRevision,
          epoch,
        );
      }
      const epoch = await this.#storage.get(STATE_EPOCH);
      return commitState(input, {
        ...token,
        project: route.project,
        principal: ["token", token.id, token.device],
        epoch,
        config: () =>
          (this.#env as { FORGE_STATE_NAMESPACES?: unknown })
            .FORGE_STATE_NAMESPACES,
        recheck: () => {
          authorizeToken(db, parts, Date.now());
        },
        open: () => this.#openWrite(),
      });
    } catch (caught) {
      const error = storageFailure(caught) ?? caught;
      if (!(error instanceof ForgeFailure)) throw error;
      await discard(request);
      return Response.json(failed(error.error), {
        status: STATUS[error.error.code] ?? 500,
      });
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
      // Synchronous commands stay current; PR verification rechecks inside its commit transaction.
      const token = authorizeToken(db, parts, Date.now());
      let writable = false;
      try {
        return await runCommand(body, {
          ...token,
          approvalConfig: this.#env,
          principal: ["token", token.id, token.device],
          project: commandProject(request)!,
          storage: this.#storage,
          idPrefix: (this.#env as { FORGE_CLOUD_ID_PREFIX?: unknown })
            .FORGE_CLOUD_ID_PREFIX,
          now: Date.now(),
          recheck: () => {
            authorize(db, parts, Date.now());
          },
          open: () => {
            writable = true;
            return this.#openWrite();
          },
        });
      } finally {
        if (writable)
          try {
            await this.#armMaintenance(
              Math.min(Date.now() + RETENTION_MS, token.expiresAt),
            );
          } catch (error) {
            console.error("Maintenance alarm could not be armed", error);
          }
      }
    } catch (caught) {
      const error = storageFailure(caught) ?? caught;
      if (!(error instanceof ForgeFailure)) throw error;
      await discard(request);
      return Response.json(failed(error.error), {
        status: STATUS[error.error.code] ?? 500,
      });
    }
  }

  #restoreStop(db: SqlDatabase, owner: StateOwner, project: string): void {
    const at = new Date(Date.now()).toISOString();
    owner = new StateOwner(db, { now: () => Date.parse(at) });
    const control = new LaneControlStore(owner, project),
      label = "cloud-restore";
    const reply = control.stop({ all: true }, label, label, at);
    if (!reply.ok) throw new ForgeFailure(reply.error);
    if (reply.result.stopped !== true || reply.result.scope !== "all")
      throw fail("UNAVAILABLE", "Restore did not establish the global stop");
    db.run(`DELETE FROM ${LANE_APPROVALS}`);
    db.run(`DELETE FROM ${LANE_BROWSER}`);
  }
  // One restore request: a whole dump, or one page of a paged restore.
  async #restore(request: Request): Promise<Response> {
    const began = Date.now();
    const project = new URL(request.url).pathname.split("/")[2]!;
    const dump = parseDump(
      await bounded(request, MAX_RESTORE_BODY, "RESTORE_TOO_LARGE"),
    );
    if (await this.#isProvisioned())
      throw new ForgeFailure({
        code: "RESTORE_TARGET_NOT_EMPTY",
        message: "A dump restores only into an empty project",
        retry: "never",
      });
    const staged = (await this.#storage.get(STAGED)) as
      { next: number; format: string } | undefined;
    let value: Record<string, unknown>;
    if (dump.format === DUMP_FORMAT) {
      if (staged !== undefined) await this.#abandon();
      const { db, owner } = this.#openWrite();
      const finish = () => this.#restoreStop(db, owner, project);
      value = { restored: restoreDump(db, owner, dump, this.#limits, finish) };
    } else {
      const page = dump as Page;
      // Page 0 starts again; any other page must be the one the last accepted page named.
      if (
        page.page !== 0 &&
        (page.page !== staged?.next || page.format !== staged?.format)
      )
        throw fail(
          "INPUT_INVALID",
          staged === undefined
            ? "No restore is under way: send page 0 first"
            : page.format !== staged.format
              ? "Restore page version changed; send page 0 to start again"
              : `Expected page ${staged.next}, or page 0 to start again`,
        );
      const { db, owner } = this.#openWrite(staged !== undefined);
      const finish = () => this.#restoreStop(db, owner, project);
      value = {
        restored: restorePage(db, owner, page, this.#limits, finish),
        page: page.page,
        done: page.last,
      };
      if (!page.last) {
        await this.#storage.put(STAGED, {
          next: page.page + 1,
          format: page.format,
        });
        return Response.json({ ok: true, value });
      }
      await this.#storage.delete(STAGED);
    }
    await this.#storage.put(STATE_EPOCH, crypto.randomUUID());
    await this.#storage.put(PROVISIONED, true);
    this.#provisioned = true;
    value.stopWindow = [began, Date.now()];
    return Response.json({ ok: true, value });
  }

  #write(
    route: "claim" | "renew" | "release",
    body: string,
    device: string,
    tokenSession: string | null,
    principal: ReceiptPrincipal,
    recheck: () => void,
    requireArm: () => void,
    expiresAt?: number,
  ): LeaseRecord {
    const checkExpiry = () => {
      recheck();
      tokenLive(expiresAt);
    };
    checkExpiry();
    return this.#lease(
      this.#admit(route, body, device, tokenSession, principal),
      checkExpiry,
      requireArm,
      expiresAt,
    );
  }

  #admit(
    route: "claim" | "renew" | "release",
    body: string,
    device: string,
    tokenSession: string | null,
    principal: ReceiptPrincipal,
  ): LeaseCommand {
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
    const rawId = text(input, "requestId");
    if (!REQUEST_ID.test(rawId))
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
    // A token bound to a session acts only as it: refused before any receipt lookup, lease read or write.
    requireTokenSession(tokenSession, checked.value.session.id);
    const holder: LeaseHolder = {
      ...checked.value,
      session: { ...checked.value.session, device },
    };
    const ttlMs =
      route === "release" ? null : ((input.ttlMs ?? null) as number);
    const generation = route === "claim" ? null : integer(input, "generation");

    const requestId = scopeRequestId("lease", principal, rawId);
    return {
      route,
      subject,
      holder,
      ttlMs,
      generation,
      rawId,
      requestId,
      scope: receiptScope(principal),
    };
  }

  #lease(
    command: LeaseCommand,
    checkExpiry: () => void,
    requireArm: () => void,
    expiresAt?: number,
  ): LeaseRecord {
    const { route, subject, holder, ttlMs, generation } = command;
    const { rawId, requestId } = command;
    this.#openWrite();
    guardLegacy(this.#open().db, rawId, requestId);
    const fingerprint = leaseFingerprint(command);
    const prior = this.#open().db.get(
      `SELECT json_remove(fingerprint,'$.retryUntil') AS fingerprint, outcome, result, created_at FROM ${REQUESTS} WHERE request_id=? AND COALESCE(json_extract(fingerprint,'$.retryUntil'),9007199254740991)>?`,
      [requestId, Date.now()],
    );
    if (prior !== undefined) {
      checkExpiry();
      if (Date.now() >= Number(prior.created_at) + RETENTION_MS)
        expiredReplay(prior.outcome !== "ok");
      if (prior.fingerprint !== fingerprint) throw requestConflict();
      return replayLease(
        command,
        prior.outcome,
        JSON.parse(String(prior.result)),
        () => this.#open().owner.lease(NAMESPACE, subject),
        Date.now(),
      );
    }
    requireArm();
    const commit = <T>(work: () => T) =>
      withDenialCapacity(this.#open().db, expiresAt, checkExpiry, work);
    try {
      // The change and its receipt commit together: if the receipt insert fails, the change rolls
      // back, so a retry after the 500 starts from the state the caller last saw.
      return commit(() => {
        if (route !== "release") {
          checkTtl(ttlMs, expiresAt);
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
        this.#record(requestId, fingerprint, "ok", lease, expiresAt);
        return lease;
      });
    } catch (error) {
      // A refusal changed no lease state (its transaction rolled back), so its receipt is one insert.
      if (recordable(error))
        commit(() => {
          this.#record(
            requestId,
            fingerprint,
            error.error.code,
            error.error,
            expiresAt,
          );
        });
      throw error;
    }
  }

  #record(
    requestId: string,
    fingerprint: string,
    outcome: string,
    result: LeaseRecord | ForgeError,
    expiresAt: number | undefined,
  ): void {
    if (
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw fail(
        "AUTH_EXPIRED",
        "Token expired before recording the lease request",
      );
    this.#open().db.run(
      `DELETE FROM ${REQUESTS} WHERE request_id IN (SELECT request_id FROM ${REQUESTS} WHERE json_extract(fingerprint,'$.retryUntil')<=? ORDER BY json_extract(fingerprint,'$.retryUntil'),request_id LIMIT ?)`,
      [Date.now(), PRUNE_RECEIPTS],
    );
    const stored = this.#open().db.run(
      `INSERT INTO ${REQUESTS} (request_id, fingerprint, outcome, result, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET fingerprint=excluded.fingerprint,outcome=excluded.outcome,result=excluded.result,created_at=excluded.created_at WHERE json_extract(fingerprint,'$.retryUntil')<=excluded.created_at`,
      [
        requestId,
        canonicalJson({
          ...(JSON.parse(fingerprint) as Record<string, unknown>),
          retryUntil: expiresAt,
        }),
        outcome,
        JSON.stringify(result),
        Date.now(),
      ],
    );
    if (stored.changes !== 1)
      throw fail("INTERNAL", "Lease request witness was not recorded");
  }
}
