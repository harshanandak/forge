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
import type { SqlRow } from "../../src/ports/store.ts";
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
        `CREATE TABLE IF NOT EXISTS ${REQUESTS} (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL)`,
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

// Test-only: conformance starts `wrangler dev` with CLOUD_TEST_FAULTS=on so a request can ask for its
// receipt insert to fail. The deployed config never sets it, so the header is ignored there.
interface FaultEnv {
  CLOUD_TEST_FAULTS?: string;
}
const FAULT_HEADER = "x-cloud-fault";

export class Project {
  readonly #db;
  readonly #owner;
  readonly #faults: boolean;

  constructor(ctx: DurableState, env: FaultEnv = {}) {
    this.#faults = env.CLOUD_TEST_FAULTS === "on";
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
        const fault =
          this.#faults &&
          request.headers.get(FAULT_HEADER) === "receipt-insert";
        return Response.json({
          ok: true,
          value: this.#write(route, body, fault),
        });
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

  #write(
    route: "claim" | "renew" | "release",
    body: string,
    fault: boolean,
  ): LeaseRecord {
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
    const prior = this.#db.get(
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
      return this.#replay(route, requestId, prior, subject, holder);
    }
    try {
      const fence = { subject, holder, generation: generation ?? 0 };
      const lease =
        route === "claim"
          ? this.#owner.acquire(NAMESPACE, subject, holder, ttlMs!, requestId)
          : route === "renew"
            ? this.#owner.renew(NAMESPACE, fence, ttlMs!)
            : this.#owner.release(NAMESPACE, fence);
      this.#record(requestId, fingerprint, "ok", lease, fault);
      return lease;
    } catch (error) {
      if (
        error instanceof ForgeFailure &&
        error.error.code.startsWith("LEASE_")
      )
        this.#record(
          requestId,
          fingerprint,
          error.error.code,
          error.error,
          fault,
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
    const current = this.#owner.lease(NAMESPACE, subject);
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
    fault: boolean,
  ): void {
    if (fault) throw new Error("Injected receipt insert failure");
    this.#db.run(
      `INSERT INTO ${REQUESTS} (request_id, fingerprint, outcome, result) VALUES (?, ?, ?, ?)`,
      [requestId, fingerprint, outcome, JSON.stringify(result)],
    );
  }
}
