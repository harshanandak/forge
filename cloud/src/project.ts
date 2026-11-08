// One Durable Object per project: Forge's state owner and lease contract behind four endpoints.
//   POST claim    { subject, holder, ttlMs, requestId }
//   POST renew    { subject, holder, generation, ttlMs, requestId }
//   POST release  { subject, holder, generation, requestId }
//   GET  holder?subject=...
// Request ids: one registry for all routes; a retry returns the first result while the fence holds.
// The object handles one request at a time and every write below runs without an await, so a
// claim race is decided in arrival order and exactly one caller wins.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { LeaseHolder, LeaseRecord } from "../../src/generated/types.ts";
import { validateLeaseHolder } from "../../src/generated/validators.ts";
import { durableStore, PRAGMA_TABLE, type DurableState } from "./store.ts";

const NAMESPACE = "forge/work";
const REQUESTS = "domain_cloud_requests";
const MAX_BODY = 8192;
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
        `CREATE TABLE IF NOT EXISTS ${REQUESTS} (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)`,
      ],
    },
  ],
  tables: [PRAGMA_TABLE, REQUESTS],
};

const fail = (code: string, message: string): ForgeFailure =>
  new ForgeFailure({ code, message, retry: "never" });
const STATUS: Record<string, number> = {
  INPUT_INVALID: 400,
  UNKNOWN_COMMAND: 404,
  INPUT_CONFLICT: 409,
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

export class Project {
  readonly #db;
  readonly #owner;

  constructor(ctx: DurableState) {
    this.#db = durableStore(ctx.storage);
    this.#owner = new StateOwner(this.#db, { now: () => Date.now() });
    this.#owner.initialize([domain]);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const route = url.pathname.split("/")[3] ?? "";
      if (request.method === "GET" && route === "holder") {
        const subject = url.searchParams.get("subject");
        if (subject === null || subject === "")
          throw fail("INPUT_INVALID", "subject is required");
        return Response.json({
          ok: true,
          value: this.#owner.lease(NAMESPACE, subject) ?? null,
        });
      }
      if (
        request.method === "POST" &&
        (route === "claim" || route === "renew" || route === "release")
      ) {
        const body = await request.text();
        if (body.length > MAX_BODY)
          throw fail("INPUT_INVALID", `body is over ${MAX_BODY} characters`);
        return Response.json({ ok: true, value: this.#write(route, body) });
      }
      throw fail("UNKNOWN_COMMAND", `No route for ${request.method} /${route}`);
    } catch (error) {
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

  #write(route: "claim" | "renew" | "release", body: string): LeaseRecord {
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
    const holder: LeaseHolder = checked.value;
    const ttlMs = route === "release" ? null : integer(input, "ttlMs");
    const generation = route === "claim" ? null : integer(input, "generation");

    // One registry of request ids for all three routes. The same id with another route or another
    // input is refused, whatever the key order inside the request. Keys are sorted before the
    // comparison, the way the state owner compares its own claim requests.
    const fingerprint = canonicalJson({
      route,
      subject,
      holder,
      generation,
      ttlMs,
    });
    const prior = this.#db.get(
      `SELECT fingerprint, result FROM ${REQUESTS} WHERE request_id=?`,
      [requestId],
    );
    if (prior !== undefined && prior.fingerprint !== fingerprint)
      throw new ForgeFailure({
        code: "INPUT_CONFLICT",
        message: "Request ID belongs to a different input",
        retry: "reconcile_first",
      });

    // A claim replay goes back through the owner, which refuses it once the lease moved on.
    if (route === "claim") {
      const lease = this.#owner.acquire(
        NAMESPACE,
        subject,
        holder,
        ttlMs!,
        requestId,
      );
      if (prior === undefined) this.#remember(requestId, fingerprint, lease);
      return lease;
    }
    if (prior !== undefined) {
      // A retry returns the first result, so a lost response never extends a lease twice. It never
      // outlives the fence: once another holder has the next generation, the replay is refused.
      const cached = JSON.parse(String(prior.result)) as LeaseRecord;
      const decision = decideLease(this.#owner.lease(NAMESPACE, subject), {
        mode: "held",
        subject,
        holder,
        generation: cached.generation,
        nowMs: Date.now(),
      });
      // A released lease stays released, so only a newer generation refuses a release replay.
      if (
        !decision.ok &&
        (route === "renew" || decision.error.code === "LEASE_STALE")
      )
        throw new ForgeFailure(decision.error);
      return cached;
    }
    const fence = { subject, holder, generation: generation! };
    const lease =
      route === "renew"
        ? this.#owner.renew(NAMESPACE, fence, ttlMs!)
        : this.#owner.release(NAMESPACE, fence);
    this.#remember(requestId, fingerprint, lease);
    return lease;
  }

  #remember(requestId: string, fingerprint: string, lease: LeaseRecord): void {
    this.#db.run(
      `INSERT INTO ${REQUESTS} (request_id, fingerprint, result) VALUES (?, ?, ?)`,
      [requestId, fingerprint, JSON.stringify(lease)],
    );
  }
}
