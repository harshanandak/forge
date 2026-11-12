// Test-only entry for the conformance run (wrangler.test.jsonc). It wraps the shipped Project so a
// request carrying `x-cloud-fault: receipt-insert` fails its receipt insert: the raw routes' row in
// domain_cloud_requests and a typed command's receipt in state_records. The shipped Worker
// (src/worker.ts, wrangler.example.jsonc) imports nothing from this file, so a deploy cannot carry the switch.
//
// It also holds a faulted request inside the wrapper so a test can force two requests to overlap:
//   x-cloud-hold: <key>   the request pauses, already inside its own fault context, until a request
//                         with `x-cloud-after: <key>` has entered the wrapper.
//   x-cloud-after: <key>  the request waits until the held request is paused, then lets it resume
//                         and runs on while the held request finishes.
// A wait that is never met ends in a 504 BARRIER_TIMEOUT reply, which fails the test by name.
//
// Device login journeys (forge-1230) also use three more test-only switches:
//   x-cloud-fault: login-write   any write to the login row fails, so a request that answers with its
//                                normal refusal proves it never reached one
//   x-cloud-ip: <address>        the request's CF-Connecting-IP ("none" removes it, "empty" blanks it)
//   x-cloud-converge: <key>:<n>  the request pauses until n requests with the same key have arrived
// The Clerk upstream here is a test double: the proof "owner" is the configured owner, anything else is refused.
import { AsyncLocalStorage } from "node:async_hooks";
import { Project as Shipped } from "../src/project.ts";
import type { DeviceUpstream } from "../src/auth/device-browser.ts";
import type { DurableState } from "../src/store.ts";
import { testIdentityVerifier } from "../../test/contract/lib/identity-verifier.ts";

export { default } from "../src/worker.ts";

const RECEIPT_INSERT = /^\s*INSERT INTO domain_cloud_requests\b/i;
const LOGIN_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b[^;]*\bdomain_cloud_login\b/i;
// A typed command receipt is a state record in namespace forge/cloud keyed request:<requestId>, so the fault
// matches the state owner's insert on its bound namespace and key, never on caller text.
const RECORD_INSERT = /^\s*INSERT INTO state_records\b/i;
const isReceiptInsert = (
  statement: string,
  bindings: readonly unknown[],
): boolean =>
  RECEIPT_INSERT.test(statement) ||
  (RECORD_INSERT.test(statement) &&
    bindings[0] === "forge/cloud" &&
    typeof bindings[1] === "string" &&
    bindings[1].startsWith("request:"));

// Each request runs inside its own context, so the fault decision follows that request through every
// await. Requests that overlap in one Durable Object cannot see each other's decision.
interface Fault {
  readonly receiptInsert: boolean;
  readonly loginWrite: boolean;
}
const current = new AsyncLocalStorage<Fault>();

const WAIT_LIMIT_MS = 10_000;

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}
function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
// True when the gate opened, false when the limit passed first.
async function opens(wait: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), WAIT_LIMIT_MS);
  });
  try {
    return await Promise.race([wait.then(() => true), limit]);
  } finally {
    clearTimeout(timer);
  }
}
const barrierTimeout = (what: string): Response =>
  Response.json(
    { ok: false, error: { code: "BARRIER_TIMEOUT", message: what } },
    { status: 504 },
  );

interface Pair {
  readonly held: Gate;
  readonly entered: Gate;
}

const redeemed = new Map<string, number>();
const redemption = {
  claimOnce: (hash: string, until: number): Promise<boolean> => {
    if ((redeemed.get(hash) ?? 0) > Date.now()) return Promise.resolve(false);
    redeemed.set(hash, until);
    return Promise.resolve(true);
  },
};
function clerk(env: unknown): DeviceUpstream {
  const vars = (env ?? {}) as Record<string, string>;
  return {
    begin: (state) =>
      Promise.resolve(
        `https://clerk.test/authorize?s=${encodeURIComponent(state)}`,
      ),
    verify: (request, now) => {
      const proof = new URL(request.url).searchParams.get("proof");
      const claims = {
        issuer: String(vars.CLERK_ISSUER),
        subject: String(vars.FORGE_OWNER_SUBJECT),
        audience: String(vars.CLERK_CLIENT_ID),
        expiresAt: now + 3_600_000,
        authenticatedAt: now - 1_000,
      };
      return testIdentityVerifier(
        new Map(proof === "owner" ? [["owner", claims]] : []),
      ).verify(proof, claims.audience, now);
    },
  };
}

export class Project extends Shipped {
  readonly #pairs = new Map<string, Pair>();
  readonly #converging = new Map<string, { seen: number; gate: Gate }>();

  constructor(ctx: DurableState, env?: unknown) {
    super(
      {
        storage: {
          sql: {
            exec: (statement, ...bindings) => {
              if (
                current.getStore()?.receiptInsert === true &&
                isReceiptInsert(statement, bindings)
              )
                throw new Error("Injected receipt insert failure");
              if (
                current.getStore()?.loginWrite === true &&
                LOGIN_WRITE.test(statement)
              )
                throw new Error("Injected login write failure");
              return ctx.storage.sql.exec(statement, ...bindings);
            },
          },
          transactionSync: (body) => ctx.storage.transactionSync(body),
          get: (key) => ctx.storage.get(key),
          put: (key, value) => ctx.storage.put(key, value),
          delete: (key) => ctx.storage.delete(key),
        },
      },
      env,
      { upstream: clerk(env), redemption },
    );
  }

  #pair(key: string): Pair {
    let pair = this.#pairs.get(key);
    if (pair === undefined) {
      pair = { held: gate(), entered: gate() };
      this.#pairs.set(key, pair);
    }
    return pair;
  }

  // Runs inside the request's fault context. Returns a reply only when a wait was never met.
  async #rendezvous(request: Request): Promise<Response | undefined> {
    const hold = request.headers.get("x-cloud-hold");
    const after = request.headers.get("x-cloud-after");
    if (hold !== null) {
      const pair = this.#pair(hold);
      pair.held.open();
      if (!(await opens(pair.entered.promise)))
        return barrierTimeout(`no request entered while "${hold}" was held`);
    } else if (after !== null) {
      const pair = this.#pair(after);
      if (!(await opens(pair.held.promise)))
        return barrierTimeout(`no request was held for "${after}"`);
      pair.entered.open();
    }
    return undefined;
  }

  // Pauses until n requests with this key are inside the wrapper, then lets them all run.
  async #converge(request: Request): Promise<Response | undefined> {
    const [key = "", count = "0"] = (
      request.headers.get("x-cloud-converge") ?? ""
    ).split(":");
    if (key === "") return undefined;
    const entry = this.#converging.get(key) ?? { seen: 0, gate: gate() };
    this.#converging.set(key, entry);
    if (++entry.seen >= Number(count)) entry.gate.open();
    return (await opens(entry.gate.promise))
      ? undefined
      : barrierTimeout(`fewer than ${count} requests reached "${key}"`);
  }

  override fetch(request: Request): Promise<Response> {
    const kind = request.headers.get("x-cloud-fault");
    const fault: Fault = {
      receiptInsert: kind === "receipt-insert",
      loginWrite: kind === "login-write",
    };
    const ip = request.headers.get("x-cloud-ip");
    if (ip !== null) {
      const headers = new Headers(request.headers);
      headers.delete("CF-Connecting-IP");
      if (ip !== "none")
        headers.set("CF-Connecting-IP", ip === "empty" ? "" : ip);
      request = new Request(request, { headers });
    }
    return current.run(fault, async () => {
      const unmet =
        (await this.#rendezvous(request)) ?? (await this.#converge(request));
      return unmet ?? super.fetch(request);
    });
  }
}
