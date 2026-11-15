import { ForgeFailure } from "../../src/contract/failure.ts";
import { parseUntrustedJson } from "../../src/contract/untrusted.ts";
import {
  INDEXED_NAMESPACE_WATERMARK,
  NAMESPACE_INDEX_PROBE,
  NAMESPACE_WATERMARK,
  StateOwner,
} from "../../src/core/state/index.ts";
import { parseRestoreJson } from "../../src/core/state/restore-json.ts";
import {
  validateStateEvent,
  validateStateRecord,
} from "../../src/generated/validators.ts";
import type { StateEvent, StateRecord } from "../../src/generated/types.ts";
import type {
  StateReadRequest,
  StateReadResult,
} from "../../src/ports/state-protocol.ts";
import type { SqlValue } from "../../src/ports/store.ts";
import { LIMITS } from "./issue-commands.ts";
import { MAX_SHOW_RESPONSE_BYTES as MAX } from "./issue-read.ts";
import { readOnlyStore, type DurableStorage } from "./store.ts";

export const STATE_EPOCH = "state:epoch";
/** One sentinel beyond this budget distinguishes exact results from refused reads. */
export const MAX_AGGREGATE_KEYS = 1000;
const fail = (code: string, message: string): never => {
  throw new ForgeFailure({ code, message, retry: "never" });
};
function invalid(): never {
  return fail("INTERNAL", "Stored state is not valid");
}
const tooLarge = (): never =>
  fail("UNAVAILABLE", "State response exceeds the byte budget");
const aggregates = [
  "COUNT(*)",
  "MAX(CASE WHEN key GLOB '*[0-9]' THEN CAST(substr(key, length(rtrim(key, '0123456789')) + 1) AS INTEGER) END)",
].flatMap((expression) =>
  ["", " AND key<?"].map(
    (upper) =>
      `SELECT ${expression} AS total, COUNT(*) AS examined FROM (SELECT key FROM state_records WHERE namespace=? AND key>=?${upper} LIMIT ?)`,
  ),
);

/** Synchronous after the epoch/token check: no owner initialization and no interleaved page writes. */
export function readState(
  storage: DurableStorage,
  input: StateReadRequest,
  project: string,
  policyRevision: string,
  epoch: unknown,
): Response {
  if (typeof epoch !== "string" || epoch.length === 0 || epoch.length > 128)
    fail(
      "UNAVAILABLE",
      "Provision state sync by issuing an admin device token for this project",
    );
  const namespace = input.namespace,
    query = input.query;
  const events = readOnlyStore(storage, "state_events", [
    NAMESPACE_WATERMARK,
    INDEXED_NAMESPACE_WATERMARK,
    NAMESPACE_INDEX_PROBE,
  ]);
  let revision = 0;
  try {
    if (events)
      revision = new StateOwner(events, {
        now: () => Date.now(),
      }).namespaceRevision(namespace);
  } catch {
    invalid();
  }
  const readVersion = { epoch: epoch as string, revision };
  if (
    input.readVersion &&
    (input.readVersion.epoch !== epoch ||
      input.readVersion.revision !== revision)
  )
    fail("REVISION_CONFLICT", "State read version changed");
  let result: StateReadResult["result"];
  if (query.kind === "count" || query.kind === "max") {
    const db = readOnlyStore(storage, "state_records", aggregates);
    const owner = db && new StateOwner(db, { now: () => Date.now() });
    const value = owner
      ? query.kind === "count"
        ? owner.count(namespace, query.prefix, MAX_AGGREGATE_KEYS)
        : owner.maxNumber(namespace, query.prefix, MAX_AGGREGATE_KEYS)
      : 0;
    if (!Number.isSafeInteger(value) || value < 0) invalid();
    result = { kind: query.kind, value };
  } else {
    if (
      query.kind !== "get" &&
      query.kind !== "range" &&
      query.kind !== "history"
    )
      return invalid();
    const history = query.kind === "history";
    const table = history ? "state_events" : "state_records";
    const params: SqlValue[] = [namespace];
    let where = "namespace=?";
    if (query.kind === "get" || query.kind === "history") {
      where += " AND key=?";
      params.push(query.key);
    }
    if (query.kind === "range") {
      if (query.from !== undefined) {
        where += " AND key>=?";
        params.push(query.from);
      }
      if (query.to !== undefined) {
        where += " AND key<?";
        params.push(query.to);
      }
    }
    if (query.kind === "history" && query.before !== undefined) {
      where += " AND sequence<?";
      params.push(query.before);
    }
    const limit = query.kind === "get" ? 1 : query.limit;
    const order = history
      ? "sequence DESC"
      : query.kind === "range" && query.descending
        ? "key DESC"
        : "key ASC";
    const source = `FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`;
    const scan = `SELECT length(CAST(body AS BLOB)) AS bytes, length(CAST(key AS BLOB)) AS keyBytes ${source}`;
    const rows = `SELECT key, ${history ? "sequence" : "revision"}, body ${source}`;
    const db = readOnlyStore(storage, table, [scan, rows]);
    params.push(limit);
    // Select only sizes first; an over-budget page never brings its bodies into Worker memory.
    const sizes = db?.all(scan, params) ?? [];
    let bytes = 0;
    for (const row of sizes) {
      const size = Number(row.bytes),
        keyBytes = Number(row.keyBytes);
      if (
        !Number.isSafeInteger(size) ||
        !Number.isSafeInteger(keyBytes) ||
        keyBytes > 2000 ||
        size < 0 ||
        keyBytes < 1
      )
        invalid();
      bytes += size + keyBytes;
      if (bytes > MAX) tooLarge();
    }
    const items: (StateRecord | StateEvent)[] = [];
    let lastSequence: number | null = null;
    for (const row of db?.all(rows, params) ?? []) {
      if (typeof row.body !== "string") invalid();
      const parsed = parseUntrustedJson(
        row.body,
        {
          ...LIMITS,
          maxBytes: MAX,
          maxStringLength: MAX,
        },
        (value) => {
          if (typeof value === "number" && !Number.isFinite(value)) invalid();
        },
      );
      if (!parsed.ok) invalid();
      try {
        parseRestoreJson(row.body);
      } catch {
        invalid();
      }
      const checked = history
        ? validateStateEvent(parsed.value)
        : validateStateRecord(parsed.value);
      if (!checked.ok) invalid();
      const item = checked.value;
      if (
        !Number.isSafeInteger(item.revision) ||
        item.namespace !== namespace ||
        item.key !== row.key ||
        (!history && item.revision !== row.revision)
      )
        invalid();
      if (history) {
        const sequence = Number(row.sequence);
        if (
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          (lastSequence !== null && sequence >= lastSequence)
        )
          invalid();
        lastSequence = sequence;
      }
      items.push(item);
    }
    const last = items.at(-1);
    if (query.kind === "get")
      result = {
        kind: "get",
        record: (items[0] as StateRecord | undefined) ?? null,
      };
    else if (query.kind === "history")
      result = {
        kind: "history",
        events: items as StateEvent[],
        next: items.length === limit ? lastSequence : null,
      };
    else
      result = {
        kind: "range",
        records: items as StateRecord[],
        next:
          items.length === limit && last
            ? last.key + (query.descending ? "" : "\0")
            : null,
      };
  }
  const body = JSON.stringify({
    ok: true,
    status: "OK",
    result: {
      version: 1,
      project,
      namespace,
      policyRevision,
      readVersion,
      result,
    },
    warnings: [],
  });
  if (new TextEncoder().encode(body).length > MAX) tooLarge();
  return new Response(body, {
    headers: { "content-type": "application/json" },
  });
}
