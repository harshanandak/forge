// Test-only entry for the conformance run (wrangler.test.jsonc). It wraps the shipped Project so a
// request carrying `x-cloud-fault: receipt-insert` fails its receipt insert. The shipped Worker
// (src/worker.ts, wrangler.example.jsonc) imports nothing from this file, so a deploy cannot carry the switch.
//
// It also holds a faulted request inside the wrapper so a test can force two requests to overlap:
//   x-cloud-hold: <key>   the request pauses, already inside its own fault context, until a request
//                         with `x-cloud-after: <key>` has entered the wrapper.
//   x-cloud-after: <key>  the request waits until the held request is paused, then lets it resume
//                         and runs on while the held request finishes.
// A wait that is never met ends in a 504 BARRIER_TIMEOUT reply, which fails the test by name.
import { AsyncLocalStorage } from "node:async_hooks";
import { Project as Shipped } from "../src/project.ts";
import type { DurableState } from "../src/store.ts";

export { default } from "../src/worker.ts";

const RECEIPT_INSERT = /^\s*INSERT INTO domain_cloud_requests\b/i;

// Each request runs inside its own context, so the fault decision follows that request through every
// await. Requests that overlap in one Durable Object cannot see each other's decision.
interface Fault {
  readonly receiptInsert: boolean;
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

export class Project extends Shipped {
  readonly #pairs = new Map<string, Pair>();

  constructor(ctx: DurableState, env?: unknown) {
    super(
      {
        storage: {
          sql: {
            exec: (statement, ...bindings) => {
              if (
                current.getStore()?.receiptInsert === true &&
                RECEIPT_INSERT.test(statement)
              )
                throw new Error("Injected receipt insert failure");
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

  override fetch(request: Request): Promise<Response> {
    const fault: Fault = {
      receiptInsert: request.headers.get("x-cloud-fault") === "receipt-insert",
    };
    return current.run(fault, async () => {
      const unmet = await this.#rendezvous(request);
      return unmet ?? super.fetch(request);
    });
  }
}
