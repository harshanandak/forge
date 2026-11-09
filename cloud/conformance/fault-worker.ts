// Test-only entry for the conformance run (wrangler.test.jsonc). It wraps the shipped Project so a
// request carrying `x-cloud-fault: receipt-insert` fails its receipt insert. The shipped Worker
// (src/worker.ts, wrangler.jsonc) imports nothing from this file, so a deploy cannot carry the switch.
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

export class Project extends Shipped {
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

  override fetch(request: Request): Promise<Response> {
    const fault: Fault = {
      receiptInsert: request.headers.get("x-cloud-fault") === "receipt-insert",
    };
    return current.run(fault, () => super.fetch(request));
  }
}
