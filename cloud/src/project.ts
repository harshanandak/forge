// One Durable Object per project: Forge's state owner and lease contract behind four endpoints.
//   POST claim    { subject, holder, ttlMs, requestId }
//   POST renew    { subject, holder, generation, ttlMs, requestId }
//   POST release  { subject, holder, generation, requestId }
//   GET  holder?subject=...
// The object handles one request at a time and every write below runs without an await, so a
// claim race is decided in arrival order and exactly one caller wins.
import { ForgeFailure } from "../../src/contract/failure.ts";
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
    if (route === "claim")
      return this.#owner.acquire(
        NAMESPACE,
        subject,
        holder,
        integer(input, "ttlMs"),
        requestId,
      );

    // The owner remembers claim ids itself; renew and release are remembered here. A retry with the
    // same id and input returns the first result, so a lost response never extends a lease twice.
    const generation = integer(input, "generation");
    const ttlMs = route === "renew" ? integer(input, "ttlMs") : 0;
    const fingerprint = JSON.stringify([
      route,
      subject,
      holder,
      generation,
      ttlMs,
    ]);
    const fence = { subject, holder, generation };
    const lease =
      route === "renew"
        ? this.#owner.renew(NAMESPACE, fence, ttlMs)
        : this.#owner.release(NAMESPACE, fence);
    this.#db.run(
      `INSERT OR REPLACE INTO ${REQUESTS} (request_id, fingerprint, result) VALUES (?, ?, ?)`,
      [requestId, fingerprint, JSON.stringify(lease)],
    );
    return lease;
  }
}
