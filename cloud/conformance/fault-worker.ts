// Test-only entry for the conformance run (wrangler.test.jsonc). It wraps the shipped Project so a
// request carrying `x-cloud-fault: receipt-insert` fails its receipt insert. The shipped Worker
// (src/worker.ts, wrangler.jsonc) imports nothing from this file, so a deploy cannot carry the switch.
import { Project as Shipped } from "../src/project.ts";
import type { DurableState } from "../src/store.ts";

export { default } from "../src/worker.ts";

const RECEIPT_INSERT = /^\s*INSERT INTO domain_cloud_requests\b/i;

export class Project extends Shipped {
  #armed: { value: boolean };

  constructor(ctx: DurableState) {
    const armed = { value: false };
    super({
      storage: {
        sql: {
          exec: (statement, ...bindings) => {
            if (armed.value && RECEIPT_INSERT.test(statement))
              throw new Error("Injected receipt insert failure");
            return ctx.storage.sql.exec(statement, ...bindings);
          },
        },
        transactionSync: (body) => ctx.storage.transactionSync(body),
      },
    });
    this.#armed = armed;
  }

  override async fetch(request: Request): Promise<Response> {
    this.#armed.value =
      request.headers.get("x-cloud-fault") === "receipt-insert";
    try {
      return await super.fetch(request);
    } finally {
      this.#armed.value = false;
    }
  }
}
