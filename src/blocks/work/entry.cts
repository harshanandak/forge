import type {
  HandlerCall,
  Operations,
  TrackerOperations,
} from "../../contract/author.ts";
import type { LeaseStateClient } from "../../assembly/state-client.ts";
import type {
  ReceiptsService,
  ProcessService,
  EnvironmentService,
  FilesService,
  CryptoService,
} from "../../assembly/providers.ts";
import type {
  StateRecord,
  TrackerItem,
  UpdateItemInput,
  ListItemsInput,
  ItemRef,
  LeaseGrant,
  LeaseHolder,
  StateEvent,
} from "../../generated/types.ts";

declare const fail: (code: string, message: string) => never;
/** `prefix` is the id prefix the item was minted with; it is kept, never shown. */
type Stored = Omit<TrackerItem, "lease" | "revision" | "updatedAt"> & {
  readonly prefix?: string;
};
type DepInput = {
  readonly id: string;
  readonly target: string;
  readonly action: "add" | "remove";
  readonly expectRevision: number;
};
type LinkInput = {
  readonly id: string;
  readonly relation: string;
  readonly url: string;
};
type WorkListInput = ListItemsInput & {
  readonly labels?: readonly string[];
  readonly createdSince?: string;
};
type WorkConfig = {
  readonly lanes?: {
    readonly max?: number;
    readonly base?: string;
    readonly discardIgnored?: readonly string[];
    readonly autopilot?: {
      readonly receiptChecks?: readonly string[];
      readonly rebuild?: { readonly argv: readonly string[] };
    };
  };
  readonly labelOrder?: readonly string[];
  readonly idPrefix?: string;
  readonly claimTtlSeconds?: number;
  readonly labels?: {
    readonly required?: readonly (
      | { readonly prefix: string; readonly oneOf?: never }
      | { readonly oneOf: readonly string[]; readonly prefix?: never }
    )[];
  };
};
type Checkpoint = {
  readonly step:
    "claimed" | "red" | "green" | "pushed" | "review" | "stopped" | "merged";
  readonly branch: string;
  readonly worktree: string;
  readonly head?: string;
  readonly pr?: string;
  readonly receipt?: string;
  readonly next: string;
};
type RecoveryPoint = Checkpoint & {
  readonly time: string;
  readonly commentId: string;
};
type ResumeRow = ItemRef & {
  readonly title: string;
  readonly step: Checkpoint["step"];
  readonly time: string;
  readonly claim?: {
    readonly status: "live" | "stale";
    readonly holder: LeaseHolder["session"];
    readonly expiresAt: string;
  };
};
type CallBudget = ItemRef & {
  readonly used: number;
  readonly left: number;
  readonly stopBy: string;
};
type Lane = {
  issue: string;
  issueId?: string;
  worktree: string;
  branch: string;
  brief: string;
  base?: string;
};
type LaneInput = ItemRef & { branch: string; brief: string };
type LaneOutput = Lane & { lease?: TrackerItem["lease"] };
type CloseIssue = (
  call: HandlerCall<TrackerOperations<"issue">["issue.close"][0]>,
  validateOnly?: boolean,
  deliveredUrl?: string,
) => Promise<TrackerItem>;
type CloseLaneInput = ItemRef & {
  pr?: number;
  noPr?: boolean;
  receipt?: string;
  dropped?: string;
  keepOpen?: boolean;
  discardIgnored?: boolean;
};
type TailInput = ItemRef & { pr?: number; head?: string };
type TailRecordInput = ItemRef & { action: number; result: string };
type TailAction = {
  lane: string;
  step: string;
  n: number;
  kind: "forge" | "run" | "harness" | "wait" | "pause" | "done";
  why: string;
  expect: string;
  budget: { actions: number; records: number };
  argv?: string[];
  ask?: string;
  raw?: string;
};
type WorkOperations = TrackerOperations<"issue"> & {
  readonly "lane.next": readonly [TailInput, TailAction];
  readonly "lane.record": readonly [
    TailRecordInput,
    { lane: string; step: string; n: number; recorded: true },
  ];
  readonly "lane.start": readonly [LaneInput, LaneOutput];
  readonly "lane.show": readonly [ItemRef, LaneOutput];
  readonly "lane.close": readonly [
    CloseLaneInput,
    {
      issue: string;
      status: string;
      removed: boolean;
      discarded: string[];
    },
  ];
  readonly "issue.checkpoint": readonly [
    ItemRef & Checkpoint,
    ItemRef & { readonly commentId: string },
  ];
  readonly "issue.resume": readonly [
    { readonly id?: string },
    (
      | { readonly items: readonly ResumeRow[] }
      | (ItemRef & {
          readonly title: string;
          readonly body?: string;
          readonly checkpoint?: RecoveryPoint;
          readonly claim?: ReturnType<LeaseStateClient["lease"]>;
          readonly delivers: readonly StateRecord[];
          readonly calls: CallBudget;
          readonly comments: readonly StateRecord[];
          readonly more: boolean;
        })
    ),
  ];
  readonly "issue.call": readonly [
    ItemRef & { readonly role: string; readonly route?: string },
    ItemRef & {
      readonly commentId: string;
      readonly call: number;
      readonly left: number;
      readonly timeboxMinutes: number;
      readonly stopBy: string;
    },
  ];
  readonly "issue.ready": readonly [
    WorkListInput,
    { items: readonly TrackerItem[] },
  ];
  readonly "issue.blocked": readonly [
    WorkListInput,
    { items: readonly TrackerItem[] },
  ];
  readonly "issue.stale": readonly [
    WorkListInput,
    { items: readonly TrackerItem[] },
  ];
  readonly "issue.comments": readonly [
    ItemRef,
    { records: readonly StateRecord[] },
  ];
  readonly "issue.events": readonly [
    ItemRef,
    { events: readonly StateEvent[] },
  ];
  readonly "issue.dep": readonly [DepInput, TrackerItem];
  readonly "issue.link": readonly [LinkInput, StateRecord];
  readonly "issue.links": readonly [
    ItemRef,
    { records: readonly StateRecord[] },
  ];
  readonly "issue.tree": readonly [
    { readonly id?: string; readonly limit?: number },
    {
      items: readonly TreeNode[];
      parentless: { count: number; ids: readonly string[] };
      closedParents: { count: number; ids: readonly string[] };
      truncated: boolean;
    },
  ];
  readonly "issue.lint": readonly [
    ListItemsInput,
    { problems: readonly string[] },
  ];
};
type TreeNode = {
  readonly item: TrackerItem;
  readonly openChildren: number;
  readonly closedChildren: number;
  readonly children: readonly TreeNode[];
};
const kinds: readonly string[] = ["task", "bug", "feature", "epic"];
/**
 * Items are stored as `work-<n>`, the form they have always had, and shown as `<idPrefix>-<n>`.
 * The number is the identity, so changing the prefix rewrites nothing. An id resolves only with
 * the current prefix or one this project has minted ids with, so another project's id is refused
 * instead of naming an unrelated item here. Malformed ids are refused before lookup.
 */
const STORED = "work-";
const QUALIFIED = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/i;
type Ids = {
  readonly prefix: string;
  readonly stored: (id: string) => string;
  readonly shown: (id: string) => string;
};
/** The current prefix and every one an item was minted with; an item from before they were recorded was minted as `work`. */
function accepted(state: LeaseStateClient, prefix: string): readonly string[] {
  const used = state
    .list("issue:")
    .map((record) => stored(record).prefix ?? "work");
  return [...new Set([prefix, ...used])];
}
function idsFor(state: LeaseStateClient, config: unknown): Ids {
  const prefix = (config as WorkConfig | undefined)?.idPrefix ?? "work";
  let known: readonly string[] | undefined;
  return {
    prefix,
    stored(id) {
      const match = QUALIFIED.exec(id);
      if (!match)
        fail(
          "INPUT_INVALID",
          `Invalid issue id ${JSON.stringify(id)}; expected <prefix>-<n> (for example ${prefix}-1)`,
        );
      const given = match[1]!.toLowerCase();
      if (given !== prefix) {
        known ??= accepted(state, prefix);
        if (!known.includes(given))
          fail(
            "INPUT_INVALID",
            `Unknown id prefix ${given} in ${id}; this project's ids carry ${known.join(", ")}`,
          );
      }
      return `${STORED}${match[2]}`;
    },
    shown(id) {
      const number = id.slice(STORED.length);
      return id.startsWith(STORED) && /^\d+$/.test(number)
        ? `${prefix}-${number}`
        : id;
    },
  };
}
const key = (id: string): string => `issue:${id}`;
function client(services: unknown): LeaseStateClient {
  if (
    typeof services !== "object" ||
    services === null ||
    !("state" in services)
  )
    fail("SERVICE_MISSING", "The work block requires its bound state service");
  const state = services.state as LeaseStateClient;
  if (
    !state ||
    typeof state.lease !== "function" ||
    typeof state.acquire !== "function"
  )
    fail(
      "SERVICE_MISSING",
      "The work block requires the lease-capable state binding",
    );
  return state;
}
function get(state: LeaseStateClient, id: string, given = id): StateRecord {
  const record = state.get(key(id));
  if (!record) fail("NOT_FOUND", `Issue ${given} was not found`);
  return record;
}
function stored(record: StateRecord): Stored {
  return record.value as Stored;
}
function live(state: LeaseStateClient, id: string) {
  const lease = state.lease(key(id));
  return lease &&
    lease.releasedAt === undefined &&
    Date.parse(lease.expiresAt) > state.now()
    ? lease
    : undefined;
}
function item(
  state: LeaseStateClient,
  record: StateRecord,
  ids: Ids,
): TrackerItem {
  const {
    closeReason: _reason,
    prefix: _prefix,
    ...value
  } = stored(record) as Stored & { closeReason?: string };
  const lease = live(state, value.id);
  return {
    ...value,
    id: ids.shown(value.id),
    dependsOn: value.dependsOn.map(ids.shown),
    ...(value.parent === undefined ? {} : { parent: ids.shown(value.parent) }),
    updatedAt: record.updatedAt,
    revision: record.revision,
    ...(lease ? { lease } : {}),
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function persist(
  state: LeaseStateClient,
  recordKey: string,
  value: unknown,
  expectRevision: number,
  subject?: string,
  readSet?: readonly {
    readonly key: string;
    readonly expectRevision: number;
  }[],
): StateRecord {
  const written = state.put(recordKey, value, {
    expectRevision,
    ...(subject === undefined ? {} : { subject }),
    ...(readSet === undefined ? {} : { readSet }),
  });
  const read = state.get(recordKey);
  if (canonical(read) !== canonical(written))
    fail(
      "INTERNAL",
      "Accepted write did not match its readback; reconcile before retrying",
    );
  return written;
}
function checkKind(kind: string | undefined): void {
  if (kind !== undefined && !kinds.includes(kind))
    fail(
      "INPUT_INVALID",
      `Unknown issue kind ${kind}; known kinds: ${kinds.join(", ")}`,
    );
}
function dependencyGraph(
  state: LeaseStateClient,
  initial: readonly StateRecord[] = [],
  edges = (value: Stored): readonly string[] => value.dependsOn,
) {
  const records = new Map<string, StateRecord | undefined>(
    initial.map((record) => [stored(record).id, record]),
  );
  const readSet: { key: string; expectRevision: number }[] = [];
  const missing = new Set<string>();
  const complete = new Map<string, boolean>();
  const read = (id: string): StateRecord | undefined => {
    if (!records.has(id)) {
      const record = state.get(key(id));
      records.set(id, record);
      if (record)
        readSet.push({ key: record.key, expectRevision: record.revision });
      else missing.add(id);
    }
    return records.get(id);
  };
  const check = (id: string, dependencies?: readonly string[]): boolean => {
    if (complete.has(id)) return complete.get(id)!;
    const root = dependencies ?? edges(stored(read(id)!));
    const active = new Set([id]);
    const stack = [{ id, dependencies: root, index: 0, valid: true }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.index === frame.dependencies.length) {
        active.delete(frame.id);
        complete.set(frame.id, frame.valid);
        stack.pop();
        if (!stack.length) return frame.valid;
        stack[stack.length - 1]!.valid &&= frame.valid;
        continue;
      }
      const next = frame.dependencies[frame.index++]!;
      if (active.has(next)) {
        frame.valid = false;
        continue;
      }
      if (complete.has(next)) {
        frame.valid &&= complete.get(next)!;
        continue;
      }
      const record = read(next);
      if (!record) {
        complete.set(next, false);
        frame.valid = false;
        continue;
      }
      active.add(next);
      stack.push({
        id: next,
        dependencies: edges(stored(record)),
        index: 0,
        valid: true,
      });
    }
    return true;
  };
  return { read, check, readSet, missing };
}
function validateDependencies(
  state: LeaseStateClient,
  id: string,
  dependencies: readonly string[],
  ids: Ids,
  parent = false,
): readonly { readonly key: string; readonly expectRevision: number }[] {
  const graph = dependencyGraph(
    state,
    [],
    parent
      ? (value) => (value.parent === undefined ? [] : [value.parent])
      : undefined,
  );
  if (!graph.check(id, dependencies)) {
    const [missing] = graph.missing;
    if (missing !== undefined)
      fail("NOT_FOUND", `Issue ${ids.shown(missing)} was not found`);
    fail(
      "INPUT_CONFLICT",
      parent
        ? "Parents must not contain a cycle"
        : "Dependencies must not contain a cycle",
    );
  }
  return graph.readSet;
}
function blocked(
  graph: ReturnType<typeof dependencyGraph>,
  value: Stored,
): boolean {
  return value.dependsOn.some((id) => {
    const dependency = graph.read(id);
    return !dependency || stored(dependency).status !== "closed";
  });
}
/** Position of the first configured label an item carries; items with none rank last. */
function rank(order: readonly string[], value: Stored): number {
  const at = order.findIndex((label) => value.labels.includes(label));
  return at === -1 ? order.length : at;
}
function list(
  state: LeaseStateClient,
  input: WorkListInput,
  mode?: "ready" | "blocked" | "stale",
  config?: WorkConfig,
): { items: readonly TrackerItem[]; truncated: boolean } {
  let records = state.list("issue:");
  const graph = dependencyGraph(state, records);
  const ids = idsFor(state, config);
  const parent =
    input.parent === undefined || input.parent === "none"
      ? undefined
      : ids.stored(input.parent);
  if (input.parent !== undefined)
    records = records.filter((record) => stored(record).parent === parent);
  if (input.kind !== undefined)
    records = records.filter((record) => stored(record).kind === input.kind);
  const wanted = [...(input.labels ?? []), ...(input.label ?? [])];
  if (wanted?.length)
    records = records.filter((record) =>
      wanted.every((label) => stored(record).labels.includes(label)),
    );
  if (input.status)
    records = records.filter(
      (record) => stored(record).status === input.status,
    );
  if (input.createdSince !== undefined) {
    const since = Date.parse(input.createdSince);
    records = records.filter(
      (record) => Date.parse(stored(record).createdAt) >= since,
    );
  }
  if (mode || input.ready)
    records = records.filter((record) => {
      const value = stored(record);
      if (value.status !== "open") return false;
      if (mode === "blocked") return blocked(graph, value);
      if (mode === "stale") {
        const lease = state.lease(key(value.id));
        return (
          lease !== undefined &&
          lease.releasedAt === undefined &&
          Date.parse(lease.expiresAt) <= state.now()
        );
      }
      return !blocked(graph, value) && !live(state, value.id);
    });
  // Missing config means no order; a stable sort keeps the stored order within one rank.
  const order = mode === "ready" ? (config?.labelOrder ?? []) : [];
  if (order.length)
    records = records.toSorted(
      (a, b) => rank(order, stored(a)) - rank(order, stored(b)),
    );
  return {
    truncated: records.length > (input.limit ?? 1000),
    items: records
      .slice(0, input.limit ?? 1000)
      .map((record) => item(state, record, ids)),
  };
}
/** `id` and `dependsOn` are stored ids; `given` is the id as the caller wrote it. */
function update(
  state: LeaseStateClient,
  input: UpdateItemInput,
  ids: Ids,
  given: string,
): TrackerItem {
  const value = stored(get(state, input.id, given));
  checkKind(input.kind);
  if (
    value.kind === "epic" &&
    value.status === "open" &&
    input.kind !== undefined &&
    input.kind !== "epic"
  ) {
    const children = state
      .list("issue:")
      .filter(
        (record) =>
          stored(record).parent === input.id &&
          stored(record).status === "open",
      ).length;
    if (children)
      fail(
        "INPUT_CONFLICT",
        `Cannot demote open epic ${given} with ${children} open children; close or reparent them first`,
      );
  }
  const readSet = input.dependsOn
    ? [...validateDependencies(state, input.id, input.dependsOn, ids)]
    : [];
  const { id, expectRevision, parent, ...patch } = input;
  const next = { ...value, ...patch };
  if (parent === null) delete next.parent;
  else if (parent !== undefined) {
    const target = ids.stored(parent);
    readSet.push(...validateDependencies(state, id, [target], ids, true));
    Object.assign(next, { parent: target });
  }
  return item(
    state,
    persist(state, key(id), next, expectRevision, undefined, readSet),
    ids,
  );
}
function appended(
  state: LeaseStateClient,
  prefix: string,
): readonly StateRecord[] {
  // Successful create-if-absent appends allocate successive numeric suffixes.
  return state
    .list(prefix)
    .toSorted(
      (a, b) =>
        Number(a.key.slice(prefix.length)) - Number(b.key.slice(prefix.length)),
    );
}
const CALL_WINDOW = 30 * 3600_000;
function callBudget(state: LeaseStateClient, ids: Ids, given: string) {
  let id = ids.stored(given);
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(id)) fail("INPUT_CONFLICT", "Issue parent cycle");
    visited.add(id);
    const parent = stored(
      get(state, id, visited.size === 1 ? given : ids.shown(id)),
    ).parent;
    if (parent === undefined) break;
    id = parent;
  }
  const comments = appended(state, `comment:${id}:`);
  const calls = comments.filter(
    (record) => typeof (record.value as { call?: unknown }).call === "number",
  );
  const stop =
    (calls[0] ? Date.parse(calls[0].updatedAt) : state.now()) + CALL_WINDOW;
  return {
    id,
    comments,
    used: calls.length,
    stop,
    minutes: Math.floor((stop - state.now()) / 60_000),
  };
}
function recovery(comments: readonly StateRecord[]): RecoveryPoint | undefined {
  const record = comments.findLast(
    (record) =>
      (record.value as { checkpoint?: Checkpoint }).checkpoint !== undefined,
  );
  if (!record) return undefined;
  return {
    ...(record.value as { checkpoint: Checkpoint }).checkpoint,
    time: record.updatedAt,
    commentId: record.key,
  };
}
function grant(
  state: LeaseStateClient,
  id: string,
  lease: ReturnType<LeaseStateClient["acquire"]>,
  ids: Ids,
): LeaseGrant {
  const read = state.lease(key(id));
  const identity = ({ actor, session }: LeaseHolder): unknown =>
    session.device === undefined
      ? { actor, id: session.id }
      : { device: session.device, id: session.id };
  // A replay returns the original expiry even if a later renewal extended the current lease.
  if (
    !read ||
    read.generation !== lease.generation ||
    canonical(identity(read.holder)) !== canonical(identity(lease.holder))
  )
    fail("INTERNAL", "Accepted lease did not match its readback");
  return {
    id: ids.shown(id),
    generation: lease.generation,
    expiresAt: lease.expiresAt,
  };
}
const required = [
  "Goal",
  "Acceptance test",
  "Files",
  "Forbidden actions",
  "Stop point",
  "Prior art",
];
function briefProblems(text: string): string[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split(/\r?\n/);
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) return ["brief frontmatter is not closed"];
    start = end + 1;
  }
  const bodies = new Map<string, string[]>();
  let current: string | undefined;
  let fence: { char: string; length: number } | undefined;
  for (const line of lines.slice(start)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ""
      )
        fence = undefined;
      else if (current) bodies.get(current)?.push(line);
      continue;
    }
    if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading && heading[1]!.length <= 2) {
      current = heading[1] === "##" ? heading[2] : undefined;
      if (current && !bodies.has(current)) bodies.set(current, []);
    } else if (current) bodies.get(current)?.push(line);
  }
  return required
    .filter(
      (name) => !bodies.get(name)?.some((line) => /[\p{L}\p{N}]/u.test(line)),
    )
    .map((name) => `brief requires non-empty section: ${name}`);
}

const registryPath = "forge-lanes.json";
const registryLock = "forge-lanes-registry.lock";
function laneFiles(services: unknown): FilesService {
  const files = (services as { files?: FilesService }).files;
  if (!files) fail("UNAVAILABLE", "Lane operations require the files service");
  return files;
}
function laneRegistry(files: FilesService): {
  text: string | null;
  lanes: Lane[];
} {
  const text = files.read(registryPath, 1_048_576, "common") ?? null;
  let value: unknown;
  try {
    value = text === null ? [] : JSON.parse(text);
  } catch {
    fail("INPUT_INVALID", "Repair the invalid lane registry before retrying");
  }
  if (
    !Array.isArray(value) ||
    !value.every(
      (row: unknown) =>
        row !== null &&
        typeof row === "object" &&
        ["issue", "worktree", "branch", "brief"].every(
          (field) =>
            typeof (row as Record<string, unknown>)[field] === "string",
        ) &&
        (!("base" in row) || typeof row.base === "string") &&
        (!("issueId" in row) ||
          (typeof row.issueId === "string" && /^work-\d+$/.test(row.issueId))),
    )
  )
    fail("INPUT_INVALID", "Repair the invalid lane registry before retrying");
  return { text, lanes: value as Lane[] };
}
function laneIdentity(lane: Lane): string {
  // Registry ids belong to this project; legacy writers stored a display prefix.
  const number = QUALIFIED.exec(lane.issue)?.[2];
  if (!number) fail("INPUT_INVALID", "Invalid issue identity in lane registry");
  return lane.issueId ?? `${STORED}${number}`;
}
function closeJournal(files: FilesService, id: string, lane?: Lane) {
  const suffix = id.slice(STORED.length);
  const name = lane
    ? `forge-lane-close-${lane.issue}.json`
    : files
        .list(".", 1024, "common")
        .find(
          (name) =>
            /^forge-lane-close-.+-\d+\.json$/.test(name) &&
            name.endsWith(`-${suffix}.json`),
        );
  const text = name ? files.read(name, 262144, "common") : undefined;
  const value: unknown = text === undefined ? undefined : JSON.parse(text);
  if (
    value !== undefined &&
    (!value || typeof value !== "object" || Array.isArray(value))
  )
    fail("INPUT_INVALID", "Invalid close journal");
  return {
    name: name ?? `forge-lane-close-${id}.json`,
    value: value as Record<string, unknown> | undefined,
  };
}
function slash(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "");
}
function briefPath(
  files: FilesService,
  path: string,
  windows: boolean,
): string {
  const root = slash(files.root),
    given = slash(path);
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  return fold(given).startsWith(fold(root) + "/")
    ? given.slice(root.length + 1)
    : given;
}
/*
 * Lane autopilot, post-merge tail (forge-885 S1). A block runs as one source file with no require,
 * so this lives here rather than in its own module. `lane.next` rebuilds its view from primary
 * facts (GitHub, the lane registry, receipts, issues) plus the journal at `autopilot:<id>`; it
 * never trusts the journal for a gate. The journal only remembers what Forge cannot read itself.
 */
type ActionStep = "receipt" | "close" | "issues" | "rebuild" | "unwatch";
type Journal = {
  id: string;
  pr: number;
  url: string;
  head: string;
  mergeCommit: string;
  branch: string;
  named: string[];
  step: ActionStep | "done";
  action?: { n: number; step: ActionStep; target?: string };
  receipt?: string;
  recorded: {
    rebuild?: { exitCode: number };
    unwatch?: { done: true };
  };
  counters: { actions: number; records: number };
};
type TailPull = {
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  headRefName: string;
  mergeCommit: string | null;
  url: string;
};
const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const journalKey = (id: string): string => `autopilot:${id}`;
/** Append-only history; a repeat of the newest event is not written again. */
function emit(
  state: LeaseStateClient,
  id: string,
  type: string,
  detail: unknown,
): void {
  const prefix = `autopilot-event:${id}:`;
  const all = appended(state, prefix);
  const last = all.at(-1)?.value as
    { type?: string; detail?: unknown } | undefined;
  if (last?.type === type && canonical(last.detail) === canonical(detail))
    return;
  persist(
    state,
    `${prefix}${all.length + 1}`,
    { id, type, at: new Date(state.now()).toISOString(), detail },
    0,
  );
}
async function readPull(
  call: { signal: AbortSignal; deadline: number },
  bound: { process?: ProcessService; environment?: EnvironmentService },
  cwd: string,
  pr: number,
): Promise<TailPull | string> {
  if (!bound.process || !bound.environment)
    fail("UNAVAILABLE", "Lane next needs process and environment services");
  const env = bound.environment.select([
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "windir",
    "ComSpec",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "GH_TOKEN",
    "GH_HOST",
    "GH_ENTERPRISE_TOKEN",
  ]);
  const gh = bound.process.resolve("gh", env);
  if (gh.kind !== "resolved")
    fail("UNAVAILABLE", "Install gh and put it on PATH");
  const remaining = call.deadline - Date.now();
  if (remaining <= 0) fail("INVOCATION_TIMEOUT", "Lane next deadline expired");
  const result = await bound.process.run(
    gh,
    [
      "pr",
      "view",
      String(pr),
      "--json",
      "state,headRefName,headRefOid,mergeCommit,url",
    ],
    {
      cwd,
      env,
      signal: call.signal,
      timeoutMs: Math.min(20000, remaining),
      maxOutputBytes: 65536,
    },
  );
  if (result.exitCode !== 0 || result.timedOut || result.truncated)
    fail("UNAVAILABLE", "Could not read the PR from GitHub; retry");
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return result.stdout.slice(0, 500);
  }
  const row = value as Record<string, unknown> | null;
  const merge = row?.mergeCommit as { oid?: unknown } | null | undefined;
  if (
    typeof row !== "object" ||
    row === null ||
    !["OPEN", "CLOSED", "MERGED"].includes(row.state as string) ||
    typeof row.headRefName !== "string" ||
    !isCommit(row.headRefOid) ||
    typeof row.url !== "string" ||
    !(merge === null || merge === undefined || isCommit(merge.oid))
  )
    return result.stdout.slice(0, 500);
  return {
    state: row.state as TailPull["state"],
    headRefOid: row.headRefOid,
    headRefName: row.headRefName,
    mergeCommit: merge?.oid === undefined ? null : (merge.oid as string),
    url: row.url,
  };
}
async function laneNext(call: HandlerCall<TailInput>): Promise<TailAction> {
  const { input, services, config } = call;
  const state = client(services),
    ids = idsFor(state, config),
    id = ids.stored(input.id);
  const issue = item(state, get(state, id, input.id), ids);
  const files = laneFiles(services);
  const bound = services as {
    process?: ProcessService;
    environment?: EnvironmentService;
    receipts?: ReceiptsService;
  };
  const settings = (config as WorkConfig | undefined)?.lanes?.autopilot;
  const record = state.get(journalKey(id));
  const saved = record?.value as Journal | undefined;
  const budget = () => ({
    actions: saved?.counters.actions ?? 0,
    records: saved?.counters.records ?? 0,
  });
  const pause = (why: string, ask: string, raw: unknown): TailAction => {
    const quoted = typeof raw === "string" ? raw : JSON.stringify(raw);
    emit(state, id, "pause", { why, raw: quoted });
    return {
      lane: issue.id,
      step: saved?.step ?? "receipt",
      n: saved?.action?.n ?? 0,
      kind: "pause",
      why,
      expect: "an owner reply; Forge guesses nothing",
      budget: budget(),
      ask,
      raw: quoted,
    };
  };
  const links = appended(state, `link:${id}:`)
    .map((row) => row.value as LinkInput)
    .filter((link) => link.relation === "delivers");
  const linked = Number(
    /\/pull\/(\d+)\/?$/.exec(links.at(-1)?.url ?? "")?.[1] ?? 0,
  );
  if (saved && input.pr !== undefined && input.pr !== saved.pr)
    return pause(
      `Journal is for PR #${saved.pr} but PR #${input.pr} was given`,
      "Which PR landed this lane? Forge keeps the journaled one until you say otherwise.",
      { journal: saved.pr, given: input.pr },
    );
  const pr = saved?.pr ?? input.pr ?? linked;
  if (!pr)
    return pause(
      `${issue.id} has no delivers link and no --pr was given`,
      "Which PR landed this lane? Run lane next again with --pr <n>.",
      { links: links.length },
    );
  const pull = await readPull(call, bound, files.root, pr);
  if (typeof pull === "string")
    return pause(
      `GitHub returned data for PR #${pr} that Forge cannot read`,
      "Check the PR by hand and tell me what to do.",
      pull,
    );
  if (pull.state === "OPEN")
    return {
      lane: issue.id,
      step: saved?.step ?? "receipt",
      n: saved?.action?.n ?? 0,
      kind: "wait",
      why: `PR #${pr} is still OPEN; the tail starts after the merge`,
      expect: `PR #${pr} state MERGED`,
      budget: budget(),
    };
  if (pull.state !== "MERGED" || pull.mergeCommit === null)
    return pause(
      `PR #${pr} is ${pull.state} without a merge commit`,
      "This PR did not merge. Close the lane as dropped, or tell me what to do.",
      pull,
    );
  if (
    input.head !== undefined &&
    input.head.toLowerCase() !== pull.headRefOid.toLowerCase()
  )
    return pause(
      `Pinned head ${input.head} but GitHub shows ${pull.headRefOid}`,
      "The PR head moved after the merge gate. Check what landed and tell me how to go on.",
      { pinned: input.head, readback: pull.headRefOid },
    );
  let journal: Journal;
  if (saved) {
    if (
      saved.head !== pull.headRefOid ||
      saved.mergeCommit !== pull.mergeCommit ||
      saved.url !== pull.url
    )
      return pause(
        `GitHub readback differs from the journal for PR #${pr}`,
        "The merged PR no longer matches what this lane recorded. Check it and tell me how to go on.",
        {
          journal: { head: saved.head, mergeCommit: saved.mergeCommit },
          readback: { head: pull.headRefOid, mergeCommit: pull.mergeCommit },
        },
      );
    journal = structuredClone(saved);
  } else {
    const checkpointHead = recovery(appended(state, `comment:${id}:`))?.head;
    const expected = input.head ?? checkpointHead;
    if (expected === undefined)
      return pause(
        `No expected head is recorded for ${issue.id}`,
        "Which head did the merge gate review? Run lane next again with --head <sha>.",
        { readback: pull.headRefOid, checkpoint: null },
      );
    if (expected.toLowerCase() !== pull.headRefOid.toLowerCase())
      return pause(
        `Expected head ${expected} but GitHub shows ${pull.headRefOid}`,
        "A different head merged than the one recorded. Check what landed and tell me how to go on.",
        {
          expected,
          source: input.head === undefined ? "checkpoint" : "--head",
          readback: pull.headRefOid,
        },
      );
    if (
      input.head !== undefined &&
      checkpointHead !== undefined &&
      input.head.toLowerCase() !== checkpointHead.toLowerCase()
    )
      return pause(
        `--head ${input.head} differs from the checkpoint head ${checkpointHead}`,
        "Which head did the merge gate review? Tell me which one is right.",
        { head: input.head, checkpoint: checkpointHead },
      );
    const lane = laneRegistry(files).lanes.find(
      (row) => laneIdentity(row) === id,
    );
    if (!lane)
      return pause(
        `No recorded lane for ${issue.id}`,
        "This lane has no registry entry, so Forge cannot tell what to finish. Tell me what to do.",
        { issue: issue.id },
      );
    if (lane.branch !== pull.headRefName)
      return pause(
        `PR #${pr} is on ${pull.headRefName} but the lane is on ${lane.branch}`,
        "The PR is on a different branch than the lane. Check it and tell me what to do.",
        { lane: lane.branch, pr: pull.headRefName },
      );
    const windows =
      (bound.environment as { platform?: string } | undefined)?.platform ===
      "win32";
    let text: string | undefined;
    let unreadable = "the file does not exist";
    try {
      text = files.read(briefPath(files, lane.brief, windows), 262144);
    } catch (error) {
      unreadable = error instanceof Error ? error.message : String(error);
    }
    if (text === undefined)
      return pause(
        `The brief for ${issue.id} cannot be read: ${unreadable}`,
        "Forge reads the brief for issues to close with this lane. Run lane next from the main checkout, where the brief is readable, or restore the file.",
        { brief: lane.brief, reason: unreadable },
      );
    const named: string[] = [];
    for (const line of text.matchAll(/^\s*(?:also\s+)?closes?\s*:\s*(.+)$/gim))
      for (const token of line[1]!.split(/[\s,]+/).filter(Boolean)) {
        if (/^(?:none|n\/a)$/i.test(token)) continue;
        if (!QUALIFIED.test(token))
          return pause(
            `The brief names ${JSON.stringify(token)}, which is not an issue id`,
            "Fix the Closes line in the brief, or tell me which issues to close.",
            token,
          );
        const other = ids.stored(token);
        if (other !== id && !named.includes(other)) named.push(other);
      }
    journal = {
      id,
      pr,
      url: pull.url,
      head: pull.headRefOid,
      mergeCommit: pull.mergeCommit,
      branch: lane.branch,
      named,
      step: "receipt",
      recorded: {},
      counters: { actions: 0, records: 0 },
    };
  }
  const merge7 = journal.mergeCommit.slice(0, 7);
  const save = () => {
    if (canonical(journal) !== canonical(saved))
      persist(state, journalKey(id), journal, record?.revision ?? 0);
  };
  const give = (
    step: ActionStep,
    target: string | undefined,
    kind: "forge" | "run" | "harness",
    why: string,
    expect: string,
    argv: string[],
  ): TailAction => {
    const same =
      journal.action?.step === step && journal.action.target === target;
    const n = same ? journal.action!.n : (journal.action?.n ?? 0) + 1;
    if (!same) {
      journal.action = { n, step, ...(target ? { target } : {}) };
      journal.counters.actions = n;
      emit(state, id, "action", { step, n, ...(target ? { target } : {}) });
    }
    journal.step = step;
    save();
    return {
      lane: issue.id,
      step,
      n,
      kind,
      why,
      expect,
      budget: { ...journal.counters },
      argv,
    };
  };
  // Verify each step from primary facts before offering the next action.
  const checks = settings?.receiptChecks ?? [];
  if (!checks.length)
    return pause(
      "No receipt checks are configured",
      "Set blocks.work.config.lanes.autopilot.receiptChecks to the check names the gate requires, then run lane next again.",
      { receiptChecks: checks },
    );
  if (journal.receipt === undefined) {
    return give(
      "receipt",
      undefined,
      "forge",
      `In a verify checkout, run git fetch origin and git checkout --detach ${journal.mergeCommit}, then run the configured checks at the merge commit. Record the receipt id it prints.`,
      `a PASS receipt whose subject is ${journal.mergeCommit}`,
      ["forge", "check", "run", "--input", JSON.stringify({ checks })],
    );
  }
  let proof: ReturnType<ReceiptsService["get"]>;
  try {
    proof = bound.receipts?.get(journal.receipt);
  } catch (error) {
    return pause(
      `Receipt ${journal.receipt} failed its integrity check`,
      "The recorded receipt is damaged. Run the checks again at the merge commit and record the new id.",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !proof ||
    proof.status !== "PASS" ||
    proof.subject !== journal.mergeCommit
  )
    return pause(
      `Receipt ${journal.receipt} is not a PASS at merge commit ${merge7}`,
      "Run the checks again at the merge commit and record the new receipt id.",
      proof ?? { receipt: journal.receipt, found: false },
    );
  const covered = proof.checked ?? [];
  const missing = checks.filter(
    (name) =>
      !covered.some((row) => row.name === name && row.status === "PASS"),
  );
  if (missing.length)
    return pause(
      `Receipt ${journal.receipt} does not pass every configured check: missing ${missing.join(", ")}`,
      "Run all the configured checks at the merge commit and record the new receipt id.",
      { receipt: journal.receipt, covers: covered, missing },
    );
  const registered = laneRegistry(files).lanes.some(
    (row) => laneIdentity(row) === id,
  );
  if (issue.status === "closed" && issue.receipt !== journal.receipt)
    return pause(
      `${issue.id} is closed with receipt ${issue.receipt ?? "none"}, not ${journal.receipt}`,
      "The issue was closed by something else. Check it and tell me how to go on.",
      { closedWith: issue.receipt ?? null, expected: journal.receipt },
    );
  if (issue.status !== "closed" || registered)
    return give(
      "close",
      undefined,
      "forge",
      `Claim the issue first with forge issue claim ${issue.id}. Lane close links the PR, closes the issue and removes the lane.`,
      `${issue.id} closed with receipt ${journal.receipt} and its lane registry entry gone`,
      [
        "forge",
        "lane",
        "close",
        issue.id,
        "--pr",
        String(pr),
        "--receipt",
        journal.receipt,
      ],
    );
  const targets = [
    ...new Set([
      ...state
        .list("link:")
        .map((row) => row.value as LinkInput)
        .filter(
          (link) =>
            link.relation === "delivers" &&
            link.url === journal.url &&
            link.id !== id,
        )
        .map((link) => link.id),
      ...journal.named,
    ]),
  ];
  for (const target of targets) {
    const other = state.get(key(target));
    if (!other)
      return pause(
        `${ids.shown(target)} is named for closing but does not exist`,
        journal.named.includes(target)
          ? `Correct it with: forge lane record ${issue.id} --action ${journal.action?.n ?? 1} --result '{"drop":"${ids.shown(target)}","reason":"<why>"}' (or {"replace":{"from":"${ids.shown(target)}","to":"<id>"},"reason":"<why>"}), then run lane next again.`
          : "A delivers link names an issue that does not exist. Fix the link, then run lane next again.",
        target,
      );
    if (stored(other).status === "open")
      return give(
        "issues",
        target,
        "forge",
        `Claim ${ids.shown(target)} first. If it has no delivers link to ${journal.url}, add one with forge issue link ${ids.shown(target)} --relation delivers --url ${journal.url}.`,
        `${ids.shown(target)} closed`,
        [
          "forge",
          "issue",
          "close",
          ids.shown(target),
          "--receipt",
          journal.receipt,
          "--reason",
          `PR #${pr} merged as ${merge7}`,
        ],
      );
  }
  const rebuild = settings?.rebuild;
  if (rebuild) {
    const built = journal.recorded.rebuild;
    if (built && built.exitCode !== 0)
      return pause(
        `The runtime rebuild exited with ${built.exitCode}`,
        "The rebuild failed. Fix it and rerun, or tell me to skip it.",
        built,
      );
    if (!built)
      return give(
        "rebuild",
        undefined,
        "run",
        "Run the configured runtime rebuild, then record its exit code.",
        "recorded, not verified",
        [...rebuild.argv],
      );
  }
  if (!journal.recorded.unwatch)
    return give(
      "unwatch",
      undefined,
      "harness",
      `Run this and do the steps it returns, so the harness stops watching PR #${pr}.`,
      "recorded, not verified",
      ["forge", "agent", "wait", "--pr", String(pr), "--done"],
    );
  journal.step = "done";
  if (canonical(journal) !== canonical(saved)) {
    save();
    emit(state, id, "done", { pr });
  }
  return {
    lane: issue.id,
    step: "done",
    n: journal.action?.n ?? 0,
    kind: "done",
    why: `PR #${pr} is merged and the tail is finished. Verified from facts: receipt, close${targets.length ? ", other issues" : ""}. Recorded, not verified: ${rebuild ? "rebuild, " : ""}unwatch.`,
    expect: "nothing further",
    budget: { ...journal.counters },
  };
}
function laneRecord(call: HandlerCall<TailRecordInput>): {
  lane: string;
  step: string;
  n: number;
  recorded: true;
} {
  const { input, services, config } = call;
  const state = client(services),
    ids = idsFor(state, config),
    id = ids.stored(input.id);
  get(state, id, input.id);
  const record = state.get(journalKey(id));
  const saved = record?.value as Journal | undefined;
  if (!record || !saved)
    return fail(
      "NOT_FOUND",
      `No autopilot journal for ${input.id}; run lane next first`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.result);
  } catch {
    return fail("INPUT_INVALID", "result must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return fail("INPUT_INVALID", "result must be a JSON object");
  const result = parsed as Record<string, unknown>;
  const journal = structuredClone(saved);
  journal.counters.records += 1;
  const open = saved.action;
  // A correction to a named target applies even when no action is open yet.
  if ("drop" in result || "replace" in result) {
    if (typeof result.reason !== "string" || !result.reason.trim())
      return fail("INPUT_INVALID", "A correction needs a nonempty reason");
    const replace = result.replace as
      { from?: unknown; to?: unknown } | undefined;
    const from = ids.stored(
      String(replace === undefined ? result.drop : replace.from),
    );
    if (!journal.named.includes(from))
      return fail(
        "INPUT_INVALID",
        `${ids.shown(from)} is not a named closing target for ${input.id}`,
      );
    journal.named = journal.named.filter((name) => name !== from);
    const to =
      replace === undefined ? undefined : ids.stored(String(replace.to));
    if (to !== undefined && to !== id && !journal.named.includes(to))
      journal.named.push(to);
    persist(state, journalKey(id), journal, record.revision);
    emit(state, id, "correct", {
      dropped: ids.shown(from),
      ...(to === undefined ? {} : { replacedBy: ids.shown(to) }),
      reason: result.reason.slice(0, 500),
    });
    return {
      lane: ids.shown(id),
      step: saved.step,
      n: input.action,
      recorded: true,
    };
  }
  if (!open || open.n !== input.action)
    return fail(
      "INPUT_CONFLICT",
      `Action ${input.action} is not the open action (${open ? `${open.n}, step ${open.step}` : "none"}); run lane next again`,
    );
  if (open.step === "receipt") {
    if (
      typeof result.receipt !== "string" ||
      !result.receipt ||
      result.receipt.length > 200
    )
      return fail("INPUT_INVALID", 'receipt step needs {"receipt":"<id>"}');
    journal.receipt = result.receipt;
  } else if (open.step === "rebuild") {
    if (
      typeof result.exitCode !== "number" ||
      !Number.isInteger(result.exitCode)
    )
      return fail("INPUT_INVALID", 'rebuild step needs {"exitCode":<integer>}');
    journal.recorded.rebuild = { exitCode: result.exitCode };
  } else if (open.step === "unwatch") {
    if (result.done !== true)
      return fail("INPUT_INVALID", 'unwatch step needs {"done":true}');
    journal.recorded.unwatch = { done: true };
  }
  // close and issues are verified from facts on the next lane.next; recording only acknowledges them.
  persist(state, journalKey(id), journal, record.revision);
  emit(state, id, "record", {
    step: open.step,
    n: open.n,
    result: input.result.slice(0, 2000),
  });
  return { lane: ids.shown(id), step: open.step, n: open.n, recorded: true };
}
const operations: Operations<WorkOperations> = {
  "lane.next": (call) => laneNext(call),
  "lane.record": (call) => laneRecord(call),
  "lane.show": ({ input, services, config }) => {
    const state = client(services),
      ids = idsFor(state, config);
    const issue = item(state, get(state, ids.stored(input.id), input.id), ids);
    const files = laneFiles(services),
      identity = ids.stored(issue.id);
    let lane = laneRegistry(files).lanes.find(
      (row) => laneIdentity(row) === identity,
    );
    const journal = closeJournal(files, identity, lane).value;
    if (
      !lane &&
      journal &&
      typeof journal.branch === "string" &&
      typeof journal.worktree === "string"
    )
      lane = {
        issue: issue.id,
        branch: journal.branch,
        worktree: journal.worktree,
        brief: "",
      };
    if (!lane) fail("NOT_FOUND", `No recorded lane for ${issue.id}`);
    const accepted =
      journal && typeof journal.pr === "number"
        ? (state.get(`landing:${identity}:${journal.pr}`)?.value as
            Record<string, unknown> | undefined)
        : undefined;
    // Only an accepted landing admits historical context; ordinary issue writes stay fenced.
    const lease =
      issue.lease ??
      (issue.status === "closed" &&
      journal?.receipt === issue.receipt &&
      journal?.keepOpen === false &&
      !journal?.dropped &&
      accepted?.id === identity &&
      accepted.pr === journal.pr &&
      accepted.receipt === journal.receipt &&
      accepted.branch === lane.branch &&
      accepted.worktree === lane.worktree &&
      accepted.generation === state.lease(key(identity))?.generation
        ? state.lease(key(identity))
        : undefined);
    return {
      ...lane,
      issue: issue.id,
      ...(lease ? { lease } : {}),
    };
  },
  "lane.start": async ({ input, services, config, signal, deadline }) => {
    const state = client(services),
      ids = idsFor(state, config);
    const issueId = ids.stored(input.id);
    const issue = item(state, get(state, issueId, input.id), ids);
    if (issue.status === "closed")
      fail("INPUT_CONFLICT", `Issue ${issue.id} is closed`);
    const files = laneFiles(services);
    const bound = services as {
      process?: ProcessService;
      environment?: EnvironmentService;
      crypto?: CryptoService;
    };
    if (!bound.process || !bound.environment || !bound.crypto)
      fail(
        "UNAVAILABLE",
        "Starting a lane requires process, environment and crypto services",
      );
    const windows = bound.environment.platform === "win32";
    const pathKey = (path: string) =>
      windows ? slash(path).toLowerCase() : slash(path);
    const relativeBrief = briefPath(files, input.brief, windows);
    const brief = files.read(relativeBrief, 262144);
    if (brief === undefined)
      fail("INPUT_INVALID", `Brief file does not exist: ${input.brief}`);
    const problems = briefProblems(brief);
    if (problems.length) fail("INPUT_INVALID", problems.join("; "));
    const executor = bound.process;
    const env = bound.environment.select([
      "PATH",
      "PATHEXT",
      "SystemRoot",
      "windir",
      "ComSpec",
      "TEMP",
      "TMP",
      "TMPDIR",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "SSH_AUTH_SOCK",
    ]);
    const git = executor.resolve("git", env);
    if (git.kind !== "resolved")
      fail("UNAVAILABLE", "Install Git and put it on PATH to start a lane");
    const run = async (args: string[], optional = false): Promise<string> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        fail("INVOCATION_TIMEOUT", "Lane start deadline expired");
      const result = await executor.run(git, args, {
        cwd: files.root,
        env,
        signal,
        timeoutMs: Math.min(60000, remaining),
        maxOutputBytes: 262144,
      });
      if (result.timedOut || result.truncated)
        fail("UNAVAILABLE", "Git timed out or exceeded the lane output limit");
      if (result.exitCode !== 0) {
        if (optional) return "";
        fail(
          "INPUT_CONFLICT",
          `git ${args[0]} failed: ${result.stderr.trim().split(/\r?\n/)[0] || "no diagnostic"}`,
        );
      }
      return result.stdout.trim();
    };
    if (
      input.branch.startsWith("-") ||
      !(await run(["check-ref-format", "--branch", input.branch], true))
    )
      fail("INPUT_INVALID", "Invalid lane branch name");
    const laneConfig = (config as WorkConfig | undefined)?.lanes;
    const remoteHead =
      laneConfig?.base ??
      ((
        await run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], true)
      ).replace(/^refs\/remotes\/origin\//, "") ||
        "main");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remoteHead))
      fail("INPUT_INVALID", "Invalid lane base");
    const baseRef = "refs/forge/lane-base/" + bound.crypto.randomUUID();
    let base: string;
    try {
      await run([
        "fetch",
        "origin",
        "+refs/heads/" + remoteHead + ":" + baseRef,
      ]);
      base = await run(["rev-parse", "--verify", baseRef + "^{commit}"]);
    } finally {
      await run(["update-ref", "-d", baseRef]);
    }
    let lock: ReturnType<FilesService["lock"]>;
    try {
      lock = files.lock([registryLock], { recoverDeadOwner: true });
    } catch {
      fail(
        "INPUT_CONFLICT",
        `Lane registry is locked; inspect ${files.roots.common}/${registryLock} before retrying`,
      );
    }
    try {
      const saved = laneRegistry(files);
      const trees = (await run(["worktree", "list", "--porcelain", "-z"]))
        .split("\0\0")
        .map((record) => {
          const fields = record.split("\0");
          return {
            path:
              fields.find((field) => field.startsWith("worktree "))?.slice(9) ??
              "",
            branch:
              fields.find((field) => field.startsWith("branch "))?.slice(7) ??
              "",
          };
        });
      const lanes: Lane[] = [];
      for (const lane of saved.lanes)
        if (
          trees.some((tree) => pathKey(tree.path) === pathKey(lane.worktree)) &&
          (await run(
            ["-C", lane.worktree, "rev-parse", "--is-inside-work-tree"],
            true,
          )) === "true"
        )
          lanes.push(lane);
      const exclude = files.read("info/exclude", 262144, "common") ?? null;
      if (!exclude?.split(/\r?\n/).includes(".worktrees/"))
        files.write("info/exclude", `${exclude ?? ""}\n.worktrees/\n`, {
          area: "common",
          expected: exclude,
        });
      const existing = lanes.find((lane) => laneIdentity(lane) === issueId);
      const worktree = `${slash(trees[0]!.path)}/.worktrees/${issue.id}`;
      const briefFile = `${slash(files.root)}/${relativeBrief}`;
      if (existing) {
        if (
          trees.find(
            (tree) => pathKey(tree.path) === pathKey(existing.worktree),
          )?.branch !== `refs/heads/${input.branch}` ||
          existing.branch !== input.branch ||
          pathKey(existing.brief) !== pathKey(briefFile)
        )
          fail(
            "INPUT_CONFLICT",
            `Issue ${issue.id} already has a different lane`,
          );
        return {
          ...existing,
          issue: issue.id,
          ...(issue.lease ? { lease: issue.lease } : {}),
        };
      }
      if (lanes.length >= (laneConfig?.max ?? 3))
        fail(
          "LIMIT_REACHED",
          `Active lane cap ${laneConfig?.max ?? 3} reached; finish a lane first`,
        );
      const adopted = trees.find(
        (tree) => pathKey(tree.path) === pathKey(worktree),
      );
      if (adopted && adopted.branch !== `refs/heads/${input.branch}`)
        fail(
          "INPUT_CONFLICT",
          `Worktree ${worktree} belongs to a different branch`,
        );
      if (!adopted)
        await run(["worktree", "add", "-b", input.branch, worktree, base]);
      const lane: Lane = {
        issue: issue.id,
        issueId,
        worktree,
        branch: input.branch,
        brief: briefFile,
        base: adopted ? await run(["-C", worktree, "rev-parse", "HEAD"]) : base,
      };
      try {
        files.write(
          registryPath,
          `${JSON.stringify([...lanes, lane], null, 2)}\n`,
          { area: "common", expected: saved.text },
        );
      } catch {
        fail(
          "INPUT_CONFLICT",
          `Worktree preserved at ${worktree}; registry publication failed. Rerun lane.start with the same arguments to adopt it`,
        );
      }
      return { ...lane, ...(issue.lease ? { lease: issue.lease } : {}) };
    } finally {
      lock.release();
    }
  },

  "lane.close": async (call) => {
    const { input, services, config, signal, deadline } = call;
    const state = client(services),
      ids = idsFor(state, config),
      id = ids.stored(input.id);
    let current = item(state, get(state, id, input.id), ids);
    if (input.dropped !== undefined && !input.dropped.trim())
      fail("INPUT_INVALID", "Supply a nonempty dropped reason");
    const files = laneFiles(services),
      bound = services as {
        process?: ProcessService;
        environment?: EnvironmentService;
        crypto?: CryptoService;
      };
    if (!bound.process || !bound.environment)
      fail("UNAVAILABLE", "Lane close needs process and environment");
    const executor = bound.process,
      env = bound.environment.select([
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "windir",
        "ComSpec",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SSH_AUTH_SOCK",
        "GH_TOKEN",
        "GH_HOST",
        "GH_ENTERPRISE_TOKEN",
      ]);
    const git = executor.resolve("git", env),
      gh = executor.resolve("gh", env);
    if (git.kind !== "resolved" || (!input.noPr && gh.kind !== "resolved"))
      fail("UNAVAILABLE", "Install Git and gh and put them on PATH");
    let next: string[][] = [];
    const refuse = (code: string, message: string): never => {
      try {
        fail(code, message);
      } catch (error) {
        const failure = error as { error?: Record<string, unknown> };
        if (failure.error) failure.error.observed = { next };
        throw error;
      }
    };
    let checkout = files.root;
    const run = async (
      args: string[],
      cwd = checkout,
      github = false,
      optional = false,
      leaveDirectory?: string,
    ) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        refuse("INVOCATION_TIMEOUT", "Lane close deadline expired");
      const executable = github ? gh : git;
      if (executable.kind !== "resolved")
        return refuse("UNAVAILABLE", "Install gh and put it on PATH");
      const result = await executor.run(executable, args, {
        cwd,
        env,
        signal,
        timeoutMs: Math.min(20000, remaining),
        maxOutputBytes: 262144,
        ...(leaveDirectory ? { leaveDirectory } : {}),
      });
      if (result.timedOut || result.truncated)
        refuse(
          "UNAVAILABLE",
          "Lane command timed out or exceeded output limit",
        );
      if (result.exitCode !== 0) {
        if (optional) return "";
        refuse(
          "INPUT_CONFLICT",
          `${github ? "gh" : "git"} ${args[0]} failed; inspect the command before resuming`,
        );
      }
      return result.stdout.trim();
    };
    checkout = (await run(["worktree", "list", "--porcelain", "-z"]))
      .split("\0")[0]!
      .slice(9);
    let lock: ReturnType<FilesService["lock"]>,
      runLock: typeof lock | undefined;
    try {
      lock = files.lock([registryLock], { recoverDeadOwner: true });
    } catch {
      fail(
        "INPUT_CONFLICT",
        `Lane registry is locked; inspect ${registryLock}`,
      );
    }
    try {
      const saved = laneRegistry(files),
        lane = saved.lanes.find((row) => laneIdentity(row) === id);
      const journal = closeJournal(files, id, lane),
        progress = journal.value;
      const branch = lane?.branch ?? progress?.branch,
        worktree = lane?.worktree ?? progress?.worktree;
      if (typeof branch !== "string" || typeof worktree !== "string")
        fail("NOT_FOUND", `No recorded lane for ${current.id}`);
      const dropped = input.dropped ?? "",
        receipt = input.receipt ?? "",
        keepOpen = !!dropped || !!input.keepOpen;
      const noPr = !!input.noPr;
      const resume = [
        "forge",
        "lane",
        "close",
        current.id,
        ...(noPr ? ["--no-pr"] : ["--pr", String(input.pr)]),
        ...(dropped ? ["--dropped", dropped] : ["--receipt", receipt]),
        ...(input.keepOpen ? ["--keep-open"] : []),
        ...(input.discardIgnored ? ["--discard-ignored"] : []),
      ];
      next = [resume];
      if (
        progress &&
        (progress.pr !== input.pr ||
          !!progress.noPr !== noPr ||
          progress.receipt !== receipt ||
          progress.keepOpen !== keepOpen ||
          (progress.dropped ?? "") !== dropped ||
          progress.branch !== branch ||
          progress.worktree !== worktree ||
          typeof progress.head !== "string")
      )
        refuse("INPUT_CONFLICT", "Resume the pending close arguments");
      const lockId =
        lane?.issue ?? journal.name.replace(/^forge-lane-close-|\.json$/g, "");
      const names = new Set([current.id, lockId, id]);
      for (const name of names) {
        const path = `forge-lane-${name}.lock`,
          info = files.inspect(path, "common");
        if (
          info &&
          (info.regular
            ? info.size > 0
            : files.list(path, 10, "common").length > 0)
        )
          refuse("INPUT_CONFLICT", `Lane run lock is held: ${path}`);
      }
      runLock = files.lock([`forge-lane-${lockId}.lock`], {
        recoverDeadOwner: true,
      });
      const pull = noPr
        ? {
            state: "CLOSED",
            headRefName: branch,
            headRefOid:
              typeof progress?.base === "string"
                ? progress.base
                : (lane?.base ?? ""),
            mergeCommit: null,
            url: "",
          }
        : (JSON.parse(
            await run(
              [
                "pr",
                "view",
                String(input.pr),
                "--json",
                "state,headRefName,headRefOid,mergeCommit,url",
              ],
              checkout,
              true,
            ),
          ) as {
            state?: string;
            headRefName?: string;
            headRefOid?: string;
            mergeCommit?: { oid?: string } | null;
            url?: string;
          });
      const commit = (value: unknown): value is string =>
        typeof value === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
      if (noPr && !commit(pull.headRefOid))
        refuse(
          "INPUT_CONFLICT",
          "Lane has no recorded base. Re-record its verified starting commit in forge-lanes.json, or close with --pr instead of --no-pr",
        );
      if (
        !pull ||
        !commit(pull.headRefOid) ||
        (!noPr &&
          (!pull.url ||
            !new RegExp(
              `^https://[^/\\s]+/[^/\\s]+/[^/\\s]+/pull/${input.pr}$`,
            ).test(pull.url))) ||
        pull.headRefName !== branch
      )
        refuse("INPUT_CONFLICT", "PR data or branch mismatch");
      if (
        dropped
          ? pull.state !== "CLOSED" || pull.mergeCommit !== null
          : pull.state !== "MERGED" || !commit(pull.mergeCommit?.oid)
      )
        refuse(
          "PR_NOT_MERGED",
          dropped
            ? "Dropped PR must be CLOSED and unmerged"
            : "PR must be MERGED with a merge commit",
        );
      const mergeCommit = pull.mergeCommit?.oid ?? "",
        ref = `refs/heads/${branch}`;
      const hasBranch = (
        await run(["for-each-ref", "--format=%(refname)", ref])
      )
        .split("\n")
        .includes(ref);
      const observedHead = hasBranch
        ? await run(["rev-parse", ref])
        : progress?.head;
      if (!commit(observedHead))
        return refuse("INPUT_CONFLICT", "Lane head is unavailable");
      let head = observedHead;
      if (
        progress &&
        (progress.head !== head ||
          (!dropped && progress.head !== pull.headRefOid) ||
          progress.mergeCommit !== mergeCommit)
      )
        refuse("INPUT_CONFLICT", "PR changed since close began");
      const exists = async () =>
        (await run(
          ["-C", worktree, "rev-parse", "--is-inside-work-tree"],
          checkout,
          false,
          true,
        )) === "true";
      const discardable = (config as WorkConfig | undefined)?.lanes
        ?.discardIgnored ?? ["node_modules/", "dist/"];
      let ignored: string[] = [];
      const clean = async () => {
        if (
          (await run(["symbolic-ref", "--short", "HEAD"], worktree)) !==
            branch ||
          (await run(["rev-parse", "HEAD"], worktree)) !== head
        )
          refuse("INPUT_CONFLICT", "Checkout is not at the lane head");
        if (
          await run(
            ["status", "--porcelain", "--untracked-files=all"],
            worktree,
          )
        )
          refuse("INPUT_CONFLICT", "Lane checkout is not clean");
        ignored = (
          await run(
            [
              "status",
              "--porcelain",
              "--ignored",
              "--untracked-files=normal",
              "-z",
            ],
            worktree,
          )
        )
          .split("\0")
          .filter((row) => row.startsWith("!! "))
          .map((row) => row.slice(3));
        const protectedPaths = ignored.filter(
          (path) =>
            !discardable.some((allowed) =>
              allowed.endsWith("/")
                ? path.startsWith(allowed)
                : path === allowed,
            ),
        );
        if (protectedPaths.length && !input.discardIgnored) {
          next = [
            ["git", "-C", worktree, "status", "--ignored"],
            [...resume, "--discard-ignored"],
          ];
          refuse(
            "INPUT_CONFLICT",
            `Preserve ignored paths before discarding: ${protectedPaths.join(", ")}`,
          );
        }
      };
      if (await exists()) await clean();
      else if (!progress) refuse("INPUT_CONFLICT", "Lane checkout is missing");
      if (!dropped && head !== pull.headRefOid) {
        next = [
          ["git", "-C", worktree, "fetch", "origin", `pull/${input.pr}/head`],
          ["git", "-C", worktree, "merge", "--ff-only", pull.headRefOid!],
          resume,
        ];
        if (!hasBranch || !(await exists()))
          refuse("INPUT_CONFLICT", "Local head differs from PR head");
        await run(["fetch", "origin", `pull/${input.pr}/head`], worktree);
        if (
          (await run(["rev-parse", "FETCH_HEAD"], worktree)) !== pull.headRefOid
        )
          refuse("INPUT_CONFLICT", "Fetched PR head changed");
        await run(
          ["merge-base", "--is-ancestor", head, pull.headRefOid!],
          worktree,
        );
        await run(["merge", "--ff-only", pull.headRefOid!], worktree);
        head = await run(["rev-parse", "HEAD"], worktree);
        if (head !== pull.headRefOid)
          refuse("INPUT_CONFLICT", "Fast-forward missed the PR head");
      }
      if (dropped && !noPr && head !== pull.headRefOid)
        await run(["fetch", "origin", `pull/${input.pr}/head`]);
      const ahead =
        dropped && head !== pull.headRefOid
          ? await run(["log", "--format=%H %s", `${pull.headRefOid}..${head}`])
          : "";
      if (noPr && head !== pull.headRefOid)
        await run(["merge-base", "--is-ancestor", pull.headRefOid!, head]);
      const links = appended(state, `link:${id}:`),
        linked = links.some((record) => {
          const link = record.value as LinkInput;
          return link.relation === "delivers" && link.url === pull.url;
        });
      if (
        (!dropped && keepOpen && current.status !== "open") ||
        (!keepOpen &&
          current.status === "closed" &&
          (!linked || current.receipt !== receipt))
      )
        refuse("INPUT_CONFLICT", "Issue was closed by another landing");
      const archive =
        progress?.archive ??
        `close-${input.pr ?? `no-pr-${bound.crypto?.randomUUID() ?? fail("UNAVAILABLE", "No-PR close requires crypto")}`}.json`;
      if (
        typeof archive !== "string" ||
        !/^close-(?:[1-9]\d*|no-pr-[0-9a-f-]{36})\.json$/i.test(archive)
      )
        return refuse("INPUT_INVALID", "Invalid close archive name in journal");
      const note =
        (dropped
          ? `${noPr ? `Lane dropped without a PR\nArchive: ${archive}` : `PR #${input.pr} dropped: ${pull.url}`}\nReason: ${dropped}`
          : `PR #${input.pr} landed: ${pull.url}\nMerge commit: ${mergeCommit}\nReceipt: ${receipt}`) +
        (ahead
          ? `\nBranch retained: ${branch}\nCommits preserved:\n${ahead}`
          : "");
      const matching = appended(state, `comment:${id}:`).find((record) => {
        const body = (record.value as { body?: string }).body;
        return (
          body === note || (!dropped && body?.startsWith(note + "\nChecks: "))
        );
      });
      const landingKey = `landing:${id}:${input.pr}`;
      const accepted = state.get(landingKey);
      const generation = state.lease(key(id))?.generation;
      const landing = {
        id,
        pr: input.pr,
        receipt,
        branch,
        worktree,
        generation,
        head,
        mergeCommit,
        note,
      };
      const recovering =
        !dropped &&
        !keepOpen &&
        current.status === "closed" &&
        accepted !== undefined &&
        canonical(accepted.value) === canonical(landing);
      if (!recovering) {
        // An empty batch asserts the caller's holder and generation without recording a write.
        state.putMany([], { subject: key(id) });
      }
      const progressState = {
        ...progress,
        pr: input.pr,
        ...(noPr ? { noPr: true, base: pull.headRefOid } : {}),
        receipt,
        keepOpen,
        dropped,
        branch,
        worktree,
        head,
        mergeCommit,
        claimed: true,
        archive,
        ...(matching ? { commentId: matching.key } : {}),
      };
      const save = () =>
        files.write(journal.name, JSON.stringify(progressState), {
          area: "common",
        });
      const closing = {
        ...call,
        input: {
          id: current.id,
          receipt,
          reason: `PR #${input.pr} merged as ${mergeCommit.slice(0, 7)}`,
        },
      };
      if (!dropped) {
        if (!linked)
          await operations["issue.link"]({
            ...call,
            input: { id: current.id, relation: "delivers", url: pull.url! },
          });
        await (operations["issue.close"] as CloseIssue)(
          closing,
          true,
          pull.url,
        );
        if (!keepOpen && !recovering)
          persist(state, landingKey, landing, accepted?.revision ?? 0, key(id));
      }
      save();
      if (!keepOpen && current.status !== "closed")
        current = await (operations["issue.close"] as CloseIssue)(
          closing,
          false,
          pull.url,
        );
      if (!matching) {
        const prefix = `comment:${id}:`,
          commentId = prefix + (state.count(prefix) + 1);
        const written = recovering
          ? state.appendLandingComment({
              id,
              pr: input.pr!,
              receipt,
              generation: generation!,
            })
          : persist(state, commentId, { id, body: note }, 0, key(id));
        Object.assign(progressState, { commentId: written.key });
        save();
      }
      if (dropped || keepOpen) state.putMany([], { subject: key(id) });
      if (hasBranch && (await run(["rev-parse", ref])) !== head)
        refuse("INPUT_CONFLICT", "Lane head changed during close");
      if (await exists()) {
        await clean();
        await run(
          [
            "worktree",
            "remove",
            ...(ignored.length ? ["--force"] : []),
            worktree,
          ],
          checkout,
          false,
          false,
          worktree,
        );
      }
      if (hasBranch && (!dropped || (noPr && head === pull.headRefOid)))
        await run(["update-ref", "-d", ref, head]);
      if (dropped)
        files.write(
          `forge-lane-runs/${lane?.issue ?? current.id}/${archive}`,
          JSON.stringify(progressState),
          { area: "common" },
        );
      files.write(
        registryPath,
        JSON.stringify(
          saved.lanes.filter((row) => laneIdentity(row) !== id),
          null,
          2,
        ) + "\n",
        { area: "common", expected: saved.text },
      );
      files.remove(journal.name, { area: "common" });
      return {
        issue: current.id,
        status: current.status,
        removed: true,
        discarded: ignored,
      };
    } finally {
      try {
        runLock?.release();
      } finally {
        lock.release();
      }
    }
  },

  "issue.create": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    checkKind(input.kind);
    const dependsOn = (input.dependsOn ?? []).map(ids.stored);
    const parent =
      input.parent === undefined ? undefined : ids.stored(input.parent);
    const sequence = state.maxNumber(`issue:${STORED}`) + 1;
    const id = `${STORED}${sequence}`;
    const readSet = validateDependencies(state, id, dependsOn, ids);
    if (parent !== undefined) get(state, parent, input.parent);
    const value: Stored = {
      id,
      prefix: ids.prefix,
      title: input.title,
      status: "open",
      labels: input.labels ?? [],
      dependsOn,
      createdAt: new Date(state.now()).toISOString(),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(parent === undefined ? {} : { parent }),
    };
    return item(
      state,
      persist(state, key(id), value, 0, undefined, readSet),
      ids,
    );
  },
  "issue.show": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    return item(state, get(state, ids.stored(input.id), input.id), ids);
  },
  "issue.list": ({ input, services, config }) =>
    list(client(services), input, undefined, config as WorkConfig | undefined),
  "issue.tree": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const records = state.list("issue:");
    const byId = new Map(records.map((record) => [stored(record).id, record]));
    const children = new Map<string, StateRecord[]>();
    for (const record of records) {
      const parent = stored(record).parent;
      if (parent !== undefined) {
        const rows = children.get(parent) ?? [];
        rows.push(record);
        children.set(parent, rows);
      }
    }
    let left = input.limit ?? 1000;
    let truncated = false;
    const take = () => {
      if (left > 0) {
        left--;
        return true;
      }
      truncated = true;
      return false;
    };
    const emitted = new Set<string>();
    const nodes = (rows: readonly StateRecord[], depth: number): TreeNode[] => {
      const result: TreeNode[] = [];
      for (const record of rows) {
        const id = stored(record).id;
        if (emitted.has(id)) continue;
        if (!take()) break;
        emitted.add(id);
        const all = children.get(id) ?? [];
        const open = all.filter((row) => stored(row).status === "open");
        if (depth === 3 && open.length) truncated = true;
        result.push({
          item: item(state, record, ids),
          openChildren: open.length,
          closedChildren: all.length - open.length,
          children: depth === 3 ? [] : nodes(open, depth + 1),
        });
      }
      return result;
    };
    const epics = records.filter(
      (record) =>
        stored(record).kind === "epic" && stored(record).status === "open",
    );
    const roots = epics.filter((record) => {
      const parent = byId.get(stored(record).parent ?? "");
      return parent === undefined || stored(parent).status !== "open";
    });
    const items =
      input.id === undefined
        ? [...nodes(roots, 0), ...nodes(epics, 0)]
        : nodes([get(state, ids.stored(input.id), input.id)], 0);
    const summary = (rows: readonly StateRecord[]) => ({
      count: rows.length,
      ids: rows
        .filter(() => take())
        .map((record) => ids.shown(stored(record).id)),
    });
    const open = records.filter((record) => stored(record).status === "open");
    return {
      items,
      parentless: summary(
        open.filter((record) => stored(record).parent === undefined),
      ),
      closedParents: summary(
        open.filter((record) => {
          const parent = byId.get(stored(record).parent ?? "");
          return parent !== undefined && stored(parent).status === "closed";
        }),
      ),
      truncated,
    };
  },
  "issue.ready": ({ input, services, config }) =>
    list(client(services), input, "ready", config as WorkConfig | undefined),
  "issue.blocked": ({ input, services, config }) =>
    list(client(services), input, "blocked", config as WorkConfig | undefined),
  "issue.stale": ({ input, services, config }) =>
    list(client(services), input, "stale", config as WorkConfig | undefined),
  "issue.update": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    return update(
      state,
      {
        ...input,
        id: ids.stored(input.id),
        ...(input.dependsOn === undefined
          ? {}
          : { dependsOn: input.dependsOn.map(ids.stored) }),
      },
      ids,
      input.id,
    );
  },
  "issue.claim": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    if (stored(get(state, id, input.id)).status !== "open")
      fail("INPUT_CONFLICT", "Closed issues cannot be claimed");
    const ttl =
      input.ttlSeconds ??
      (config as WorkConfig | undefined)?.claimTtlSeconds ??
      3600;
    const acquired = state.acquire(key(id), ttl * 1000);
    // Another holder may close between the initial read and acquisition.
    if (stored(get(state, id, input.id)).status !== "open") {
      state.release(key(id));
      fail(
        "INPUT_CONFLICT",
        "The issue closed during acquisition; the grant was revoked",
      );
    }
    return grant(state, id, acquired, ids);
  },
  "issue.renew": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    get(state, id, input.id);
    const ttl =
      input.ttlSeconds ??
      (config as WorkConfig | undefined)?.claimTtlSeconds ??
      3600;
    return grant(state, id, state.renew(key(id), ttl * 1000), ids);
  },
  "issue.release": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    get(state, id, input.id);
    const released = state.release(key(id));
    if (canonical(state.lease(key(id))) !== canonical(released))
      fail("INTERNAL", "Released lease did not match its readback");
    return { id: ids.shown(id) };
  },
  "issue.close": async (
    { input, services, config, signal },
    validateOnly = false,
    deliveredUrl?: string,
  ) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    const record = get(state, id, input.id);
    if (input.receipt !== undefined) {
      const receipts = (services as { receipts?: ReceiptsService }).receipts;
      if (!receipts || typeof receipts.get !== "function")
        fail(
          "RECEIPTS_UNAVAILABLE",
          "Cannot verify receipt: the receipts slot is unbound; bind forge.receipts@1 or omit receipt and supply withoutReceipt",
        );
      const receipt = receipts.get(input.receipt);
      if (!receipt || receipt.status !== "PASS")
        fail(
          "RECEIPT_INVALID",
          "Closing requires an existing verified PASS receipt",
        );
      const link = appended(state, `link:${id}:`).findLast((record) => {
        const link = record.value as LinkInput;
        return (
          link.relation === "delivers" &&
          (deliveredUrl === undefined || link.url === deliveredUrl)
        );
      })?.value as LinkInput | undefined;
      if (
        !link ||
        !/^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*\/?$/.test(
          link.url,
        )
      )
        fail("PR_UNLINKED", "Link the delivered pull request before closing");
      const bound = services as {
        process?: ProcessService;
        environment?: EnvironmentService;
      };
      if (!bound.process || !bound.environment)
        fail(
          "UNAVAILABLE",
          "Verifying the delivered PR requires process and environment services",
        );
      let output: string;
      try {
        const env = bound.environment.select([
          "PATH",
          "PATHEXT",
          "SystemRoot",
          "windir",
          "ComSpec",
          "TEMP",
          "TMP",
          "TMPDIR",
          "HOME",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "GH_TOKEN",
          "GH_HOST",
          "GH_ENTERPRISE_TOKEN",
        ]);
        const gh = bound.process.resolve("gh", env);
        if (gh.kind !== "resolved")
          fail("UNAVAILABLE", "Install gh to verify the delivered PR");
        const result = await bound.process.run(
          gh,
          ["pr", "view", link.url, "--json", "state,headRefOid,mergeCommit"],
          {
            cwd: bound.process.cwd,
            env,
            timeoutMs: 20000,
            maxOutputBytes: 16384,
            signal,
          },
        );
        if (result.exitCode !== 0 || result.timedOut || result.truncated)
          fail("UNAVAILABLE", "Could not read the delivered PR; retry");
        output = result.stdout;
      } catch {
        fail("UNAVAILABLE", "Could not read the delivered PR; retry");
      }
      let pr: unknown;
      try {
        pr = JSON.parse(output);
      } catch {
        fail("UNAVAILABLE", "gh returned invalid PR data");
      }
      const commit = (value: unknown): value is string =>
        typeof value === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
      if (
        typeof pr !== "object" ||
        pr === null ||
        !("state" in pr) ||
        typeof pr.state !== "string" ||
        !["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
        !("headRefOid" in pr) ||
        !commit(pr.headRefOid) ||
        !("mergeCommit" in pr) ||
        !(
          pr.mergeCommit === null ||
          (typeof pr.mergeCommit === "object" &&
            "oid" in pr.mergeCommit &&
            commit(pr.mergeCommit.oid))
        ) ||
        (pr.state === "MERGED" && pr.mergeCommit === null)
      )
        fail("UNAVAILABLE", "gh returned invalid PR data");
      if (pr.state !== "MERGED")
        fail(
          "PR_NOT_MERGED",
          "The newest delivered PR must be merged before closing",
        );
      if (
        receipt.subject !== pr.headRefOid &&
        receipt.subject !== (pr.mergeCommit as { oid: string }).oid
      )
        fail(
          "RECEIPT_HEAD_MISMATCH",
          "Receipt must cover the delivered PR's final head or merge commit",
        );
    } else if (!input.withoutReceipt?.trim()) {
      fail(
        "RECEIPT_REQUIRED",
        "Supply a PASS receipt or an explicit withoutReceipt reason",
      );
    }
    if (validateOnly) return item(state, record, ids);
    const {
      receipt: _previousReceipt,
      withoutReceipt: _previousExemption,
      ...previous
    } = stored(record);
    // The reason and status share one accepted record; there is no second close write.
    const value = {
      ...previous,
      status: "closed",
      ...(input.receipt === undefined
        ? { withoutReceipt: input.withoutReceipt! }
        : { receipt: input.receipt }),
      ...(input.reason === undefined ? {} : { closeReason: input.reason }),
    };
    const written = persist(state, key(id), value, record.revision);
    const { closeReason: _reason, ...view } = written.value as Stored & {
      closeReason?: string;
    };
    return item(state, { ...written, value: view }, ids);
  },
  "issue.comment": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    get(state, id, input.id);
    const prefix = `comment:${id}:`;
    const commentId = `${prefix}${state.count(prefix) + 1}`;
    persist(state, commentId, { id, body: input.body }, 0);
    return { id: ids.shown(id), commentId };
  },
  "issue.call": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const { id, comments, used, stop, minutes } = callBudget(
      state,
      ids,
      input.id,
    );
    const prefix = `comment:${id}:`;
    if (used >= 60 || minutes < 1)
      fail(
        "LIMIT_REACHED",
        `Intent ${ids.shown(id)} is limited to 60 calls and 30 hours`,
      );
    const call = used + 1;
    const commentId = `${prefix}${comments.length + 1}`;
    const written = persist(
      state,
      commentId,
      {
        id,
        body: `call ${call} ${input.role}${input.route === undefined ? "" : ` ${input.route}`}`,
        call,
      },
      0,
    );
    return {
      id: ids.shown(id),
      commentId,
      call,
      left: 60 - call,
      timeboxMinutes: Math.min(45, minutes),
      stopBy: new Date(
        used ? stop : Date.parse(written.updatedAt) + CALL_WINDOW,
      ).toISOString(),
    };
  },
  "issue.checkpoint": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    get(state, id, input.id);
    const length = [...input.next].length;
    if (!length || length > 300)
      fail("INPUT_INVALID", "Checkpoint next must contain 1-300 characters");
    const { id: _given, ...checkpoint } = input;
    const prefix = `comment:${id}:`;
    const commentId = `${prefix}${state.count(prefix) + 1}`;
    persist(
      state,
      commentId,
      {
        id,
        body: `checkpoint ${input.step}${input.head ? ` ${input.head}` : ""} next: ${input.next}`,
        checkpoint,
      },
      0,
    );
    return { id: ids.shown(id), commentId };
  },
  "issue.resume": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    if (input.id === undefined) {
      const items: ResumeRow[] = [];
      for (const record of state.list("issue:")) {
        const value = stored(record);
        if (value.status !== "open") continue;
        const checkpoint = recovery(appended(state, `comment:${value.id}:`));
        if (!checkpoint || checkpoint.step === "merged") continue;
        const lease = state.lease(key(value.id));
        items.push({
          id: ids.shown(value.id),
          title: value.title,
          step: checkpoint.step,
          time: checkpoint.time,
          ...(lease && lease.releasedAt === undefined
            ? {
                claim: {
                  status: live(state, value.id) ? "live" : "stale",
                  holder: lease.holder.session,
                  expiresAt: lease.expiresAt,
                },
              }
            : {}),
        });
      }
      return {
        items: items
          .toSorted(
            (a, b) =>
              Date.parse(b.time) - Date.parse(a.time) ||
              a.id.localeCompare(b.id),
          )
          .slice(0, 10),
      };
    }
    const id = ids.stored(input.id);
    const value = stored(get(state, id, input.id));
    const all = appended(state, `comment:${id}:`);
    const checkpoint = recovery(all);
    const comments = checkpoint
      ? all.slice(
          all.findIndex((record) => record.key === checkpoint.commentId) + 1,
        )
      : all;
    const claim = live(state, id);
    const budget = callBudget(state, ids, input.id);
    return {
      id: ids.shown(id),
      title: value.title,
      ...(value.body === undefined ? {} : { body: value.body }),
      ...(checkpoint ? { checkpoint } : {}),
      ...(claim ? { claim } : {}),
      delivers: appended(state, `link:${id}:`).filter(
        (record) =>
          (record.value as { relation?: string }).relation === "delivers",
      ),
      calls: {
        id: ids.shown(budget.id),
        used: budget.used,
        left: Math.max(0, 60 - budget.used),
        stopBy: new Date(budget.stop).toISOString(),
      },
      comments: comments.slice(-20),
      more: comments.length > 20,
    };
  },
  "issue.comments": ({ input, services, config }) => {
    const state = client(services);
    const id = idsFor(state, config).stored(input.id);
    get(state, id, input.id);
    return { records: appended(state, `comment:${id}:`) };
  },
  "issue.events": ({ input, services, config }) => {
    const state = client(services);
    const id = idsFor(state, config).stored(input.id);
    get(state, id, input.id);
    return { events: state.events(key(id)) };
  },
  "issue.dep": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    const value = stored(get(state, id, input.id));
    const target = ids.stored(input.target);
    const dependsOn =
      input.action === "add"
        ? [...new Set([...value.dependsOn, target])]
        : value.dependsOn.filter((dependency) => dependency !== target);
    if (dependsOn.length > 256)
      fail("INPUT_INVALID", "At most 256 dependencies are allowed");
    return update(
      state,
      { id, expectRevision: input.expectRevision, dependsOn },
      ids,
      input.id,
    );
  },
  "issue.link": ({ input, services, config }) => {
    const state = client(services);
    const id = idsFor(state, config).stored(input.id);
    get(state, id, input.id);
    if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(input.url))
      fail("INPUT_INVALID", "Links require an http or https URL");
    const prefix = `link:${id}:`;
    return persist(
      state,
      `${prefix}${state.count(prefix) + 1}`,
      { ...input, id },
      0,
      key(id),
    );
  },
  "issue.links": ({ input, services, config }) => {
    const state = client(services);
    const id = idsFor(state, config).stored(input.id);
    get(state, id, input.id);
    return { records: appended(state, `link:${id}:`) };
  },
  "issue.lint": ({ services, config }) => {
    const state = client(services);
    const problems: string[] = [];
    const records = state.list("issue:");
    const graph = dependencyGraph(state, records);
    const ids = idsFor(state, config);
    for (const record of records) {
      const value = stored(record);
      const id = ids.shown(value.id);
      if (value.kind !== undefined && !kinds.includes(value.kind))
        problems.push(`${id}: unknown kind`);
      if (!graph.check(value.id))
        problems.push(`${id}: missing or cyclic dependency`);
      const parent =
        value.parent === undefined ? undefined : graph.read(value.parent);
      if (value.parent !== undefined && !parent)
        problems.push(`${id}: missing parent`);
      if (value.status !== "open") continue;
      if (parent && stored(parent).status === "closed")
        problems.push(
          `${id}: parent ${ids.shown(stored(parent).id)} is closed`,
        );
      for (const group of (config as WorkConfig | undefined)?.labels
        ?.required ?? []) {
        const count = value.labels.filter((label) =>
          group.prefix !== undefined
            ? label.startsWith(group.prefix)
            : group.oneOf.includes(label),
        ).length;
        if (count !== 1)
          problems.push(
            `${id}: expected exactly one label from ${group.prefix ?? group.oneOf.join(", ")}; found ${count}`,
          );
      }
    }
    return { problems };
  },
};
module.exports = operations;
