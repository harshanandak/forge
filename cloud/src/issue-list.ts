import manifest from "../../src/blocks/work/forge.block.json" with { type: "json" };
import type { TrackerItem } from "../../src/generated/types.ts";
import type { SqlRow } from "../../src/ports/store.ts";
import { INDEX_PAGE, INDEX_STATUS, ISSUE_INDEX } from "./issue-index.ts";
import {
  configured,
  fail,
  holdsLease,
  invalid,
  issueRecord,
  leaseOf,
  minted,
  schemas,
  shownId,
  shownItem,
  storedId,
  type IssueViews,
} from "./issue-read.ts";

type Input = {
  parent?: string;
  kind?: string;
  label?: string[];
  labels?: string[];
  status?: string;
  createdSince?: string;
  ready?: boolean;
  limit?: number;
};
type Stored = {
  status: string;
  kind?: string;
  parent?: string;
  labels: string[];
  createdAt: string;
  dependsOn: string[];
  prefix?: unknown;
};

/** Ready mode: open, unblocked, unleased issues only, ranked by `labelOrder`. */
export type ReadyMode = { readonly labelOrder: readonly string[] };
/** Blocked: open with a dependency that is missing or not closed. Stale: open with an unreleased, expired lease. */
export type ListMode = "blocked" | "stale";
export const MAX_SCAN_ROWS = 10_000;
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
for (const op of [
  "issue.list",
  "issue.ready",
  "issue.blocked",
  "issue.stale",
] as const) {
  if (manifest.operations[op].input !== "schemas/ListItemsInput.json")
    throw new Error(`${op} no longer declares schemas/ListItemsInput.json`);
  if (manifest.operations[op].output !== "schemas/ListItemsOutput.json")
    throw new Error(`${op} no longer declares schemas/ListItemsOutput.json`);
}

/** The first `order` label a stored issue carries, as its rank; no match ranks last. */
const rank = (order: readonly string[], issue: Stored): number => {
  const at = order.findIndex((label) => issue.labels.includes(label));
  return at === -1 ? order.length : at;
};

const MIN_BATCH = 64;
const MAX_BATCH = 256;
const ISSUE = "issue:";

const names = (text: unknown): string[] => {
  const parsed: unknown = typeof text === "string" ? JSON.parse(text) : null;
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "string"))
    throw invalid();
  return parsed;
};
const indexed = <T>(read: () => T): T => {
  try {
    return read();
  } catch (error) {
    if (String(error).toLowerCase().includes(`no such table: ${ISSUE_INDEX}`))
      throw fail("UNAVAILABLE", "Issue index needs POST /p/<project>/upgrade");
    throw error;
  }
};
const usable = (row: SqlRow, prefix: string): SqlRow => {
  if (Number(row.ok) === 2)
    throw fail(
      "UNAVAILABLE",
      `Issue ${shownId(String(row.key).slice(ISSUE.length), prefix)} is over its read budget`,
    );
  if (Number(row.ok) !== 1) throw invalid();
  return row;
};
const stored = (row: SqlRow, prefix: string): Stored => {
  usable(row, prefix);
  return {
    status: String(row.status),
    ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
    ...(typeof row.parent === "string" ? { parent: row.parent } : {}),
    labels: names(row.labels),
    createdAt: String(row.created_at),
    dependsOn: names(row.depends_on),
  };
};

/** The issues in key order, `limit` at most, and whether more were stored than were returned. */
export function listIssues(
  views: IssueViews,
  input: unknown,
  now: number,
  prefix: string,
  ready?: ReadyMode,
  mode?: ListMode,
): { items: TrackerItem[]; truncated: boolean } {
  configured(prefix);
  if (schemas().validate("#", input).length > 0)
    throw fail("INPUT_INVALID", "Invalid issue list input");
  const { limit = 1000, label = [], labels = [], ...by } = input as Input;
  const parent =
    by.parent === undefined || by.parent === "none"
      ? undefined
      : storedId(by.parent, prefix, minted(views.records));
  const since = by.createdSince === undefined ? 0 : Date.parse(by.createdSince);
  const closed = (dep: string) => {
    const row = indexed(() =>
      views.records?.get(INDEX_STATUS, [`${ISSUE}${dep}`]),
    );
    return row !== undefined && usable(row, prefix).status === "closed";
  };
  const leases = new Map<string, ReturnType<typeof leaseOf>>();
  const lease = (id: string) => {
    if (!leases.has(id)) leases.set(id, leaseOf(views, id));
    return leases.get(id);
  };
  const wanted = [...labels, ...label];
  const onlyReady =
    mode === undefined && (ready !== undefined || by.ready === true);
  const inMode = (id: string, v: Stored): boolean => {
    if (v.status !== "open") return false;
    if (mode === "blocked") return v.dependsOn.some((dep) => !closed(dep));
    const held = lease(id);
    return (
      !holdsLease(held, now) &&
      held !== undefined &&
      held.releasedAt === undefined &&
      Date.parse(String(held.expiresAt)) <= now
    );
  };
  const order = ready?.labelOrder ?? [];
  const batch = Math.max(MIN_BATCH, Math.min(limit + 1, MAX_BATCH));
  const picked: { id: string; v: Stored; size: number }[] = [];
  let after = ISSUE,
    full = false;
  for (;;) {
    const rows =
      indexed(() => views.records?.all(INDEX_PAGE, [after, batch])) ?? [];
    const checked = rows.map((row) => ({
      id: String(row.key).slice(ISSUE.length),
      v: stored(row, prefix),
      size: Number(row.size),
    }));
    for (const { id, v, size } of checked) {
      const ok =
        (by.parent === undefined || v.parent === parent) &&
        (by.kind === undefined || v.kind === by.kind) &&
        wanted.every((name) => v.labels.includes(name)) &&
        (by.status === undefined || v.status === by.status) &&
        (by.createdSince === undefined || Date.parse(v.createdAt) >= since) &&
        (mode === undefined || inMode(id, v)) &&
        (!onlyReady ||
          (v.status === "open" &&
            v.dependsOn.every(closed) &&
            !holdsLease(lease(id), now)));
      if (!ok) continue;
      picked.push({ id, v, size });
      if (order.length === 0 && picked.length > limit) {
        full = true;
        break;
      }
    }
    if (full || rows.length < batch) break;
    after = String(rows.at(-1)!.key);
  }
  const ranked =
    order.length === 0
      ? picked
      : picked.toSorted((a, b) => rank(order, a.v) - rank(order, b.v));
  const page = ranked.slice(0, limit);
  if (page.reduce((sum, p) => sum + p.size, 0) > MAX_SCAN_BYTES)
    throw fail("UNAVAILABLE", "Issue list is over its read budget");
  return {
    items: page.map(({ id }) => {
      const full = issueRecord(views, id);
      if (full === undefined) throw invalid();
      return shownItem(full, id, lease(id), now, prefix);
    }),
    truncated: ranked.length > limit,
  };
}
