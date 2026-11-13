// Independent expected tables after restore; no production release path is used as the oracle.
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { LeaseRecord } from "../../src/generated/types.ts";
import type { Tables } from "./max-source.ts";

export const releaseEvent = (
  namespace: string,
  lease: LeaseRecord,
  at: string,
) => ({
  type: `${namespace}:lease.released@1`,
  namespace,
  key: lease.subject,
  revision: lease.generation,
  at,
  actor: lease.holder.actor,
  data: { ...lease, releasedAt: at },
});
export function releasedTables(source: Tables, at: string, floors = 0): Tables {
  const tables = structuredClone(source);
  for (const row of tables.state_leases!) {
    const lease = JSON.parse(String(row.body)) as LeaseRecord;
    if (
      lease.releasedAt !== undefined ||
      Date.parse(lease.expiresAt) <= Date.parse(at)
    )
      continue;
    const event = releaseEvent(String(row.namespace), lease, at);
    row.body = canonicalJson(event.data);
    tables.state_events!.push({
      sequence: tables.state_events!.length + floors + 1,
      namespace: row.namespace!,
      key: row.subject!,
      body: canonicalJson(event),
    });
  }
  return tables;
}
