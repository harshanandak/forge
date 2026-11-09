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
      readonly enabled?: boolean;
      readonly budgets?: {
        readonly calls?: number;
        readonly reviewRounds?: number;
        readonly ciFixRounds?: number;
        readonly activeHours?: number;
      };
      readonly load?: {
        readonly minFreeMemoryMb?: number;
        readonly maxCpuPercent?: number;
      };
      readonly receiptChecks?: readonly string[];
      readonly rebuild?: { readonly argv: readonly string[] };
      readonly merge?: MergeSettings;
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
type NextInput = {
  readonly id?: string;
  readonly all?: boolean;
  readonly pr?: number;
  readonly head?: string;
};
type StopInput = { readonly id?: string; readonly all?: boolean };
type ResumeInput = StopInput & {
  readonly approval?: { readonly quote?: string };
};
type Usage = { used: number; limit: number };
type LaneRow = {
  id: string;
  step: string;
  pr?: number;
  stopped: boolean;
  calls: Usage;
  activeHours: Usage;
  rounds: { review: Usage; ci: Usage };
};
type Load = { freeMemoryMb: number; cpuBusyPercent: number };
type LaneStatus = {
  enabled: boolean;
  stopped: boolean;
  stoppedLanes: string[];
  hold?: string;
  load?: Load;
  lanes: LaneRow[];
};
type MergeGateInput = {
  head: string;
  verdict: "MERGE" | "FIX";
  reviewer: string;
};
type ReplySource = { harness: string; thread: string; message?: string };
type TailRecordInput = {
  id?: string;
  action?: number;
  result?: string;
  mergeGate?: MergeGateInput;
  reply?: string;
  source?: ReplySource;
  request?: string;
  replaces?: string;
  scope?: Record<string, unknown>;
  ownerChannel?: Channel;
  approval?: unknown;
};
type ReplyResult = {
  recorded: true;
  mapped: boolean;
  answers: { lane: string; label: string; choice: string; hold: boolean }[];
  approvals: {
    lane: string;
    op: string;
    input: Record<string, unknown>;
    approval: { request: string; quote: string; source: ReplySource };
  }[];
};
type TailAction = {
  lane: string;
  step: string;
  n: number;
  kind:
    | "forge"
    | "run"
    | "harness"
    | "wait"
    | "pause"
    | "done"
    | "ask-owner"
    | "hand-to-owner";
  why: string;
  expect: string;
  budget: { actions: number; records: number };
  argv?: string[];
  ask?: string;
  raw?: string;
  approval?: { request: string; quote: string; source: ReplySource };
};
type WorkOperations = TrackerOperations<"issue"> & {
  readonly "lane.next": readonly [
    NextInput,
    TailAction | { actions: TailAction[] },
  ];
  readonly "lane.stop": readonly [StopInput, { stopped: string; at: string }];
  readonly "lane.resume": readonly [ResumeInput, { resumed: string }];
  readonly "lane.status": readonly [Record<string, never>, LaneStatus];
  readonly "lane.record": readonly [
    TailRecordInput,
    { lane: string; step: string; n: number; recorded: true } | ReplyResult,
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
/**
 * A registered lane holds a slot against the lane cap while its issue is open or still leased. A
 * lane whose issue is closed with no live lease needs nothing more from its owner, and a lane whose
 * issue cannot be found keeps its slot.
 */
function holdsSlot(state: LeaseStateClient, lane: Lane): boolean {
  const id = laneIdentity(lane),
    record = state.get(key(id));
  return (
    !record || stored(record).status === "open" || live(state, id) !== undefined
  );
}
// The branch lanes start from and land on: the configured base, else the
// remote default branch, else main.
async function laneMainBranch(
  config: unknown,
  originHead: () => Promise<string>,
): Promise<string> {
  const name =
    (config as WorkConfig | undefined)?.lanes?.base ??
    ((await originHead()).replace(/^refs\/remotes\/origin\//, "") || "main");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name))
    fail("INPUT_INVALID", "Invalid lane base");
  return name;
}

// Private refs live in one namespace. Naming a destination does not switch off
// the configured fetch mappings, so these flags keep the fetch from also moving
// remote-tracking branches, following tags, pruning or fetching submodules
// (which would not get the empty refmap).
const PRIVATE_FETCH_FLAGS = [
  "--refmap=",
  "--no-tags",
  "--no-prune",
  "--no-recurse-submodules",
];
const PRIVATE_REF_MAX_AGE_MS = 3600000;
const PRIVATE_REF =
  /^refs\/forge\/lane-(?:close|base)\/(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Lane time comes from an optional clock service, so a test can move it without
// touching the global Date. No clock is provided in production.
function laneClock(services: unknown): () => number {
  const clock = (services as { clock?: { now?: () => number } }).clock;
  return () => clock?.now?.() ?? Date.now();
}
function privateRefName(
  kind: "lane-close" | "lane-base",
  id: string,
  now: number,
): string {
  return `refs/forge/${kind}/${now}-${id}`;
}
// Cleanup never throws and never reads the call's deadline or signal: a
// cancelled call must still report its own error. If the process service
// refuses the call, the next lane command sweeps the ref.
async function bestEffortGit(
  executor: ProcessService,
  git: Parameters<ProcessService["run"]>[0],
  cwd: string,
  env: Readonly<Record<string, string>>,
  args: string[],
): Promise<string> {
  try {
    const result = await executor.run(git, args, {
      cwd,
      env,
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    return result.exitCode === 0 && !result.timedOut
      ? result.stdout.trim()
      : "";
  } catch {
    return "";
  }
}
async function dropPrivateRefs(
  executor: ProcessService,
  git: Parameters<ProcessService["run"]>[0],
  cwd: string,
  env: Readonly<Record<string, string>>,
  refs: string[],
): Promise<void> {
  for (const ref of refs)
    // --no-deref: a symbolic ref must be removed itself, never its target.
    await bestEffortGit(executor, git, cwd, env, [
      "update-ref",
      "-d",
      ref,
      "--no-deref",
    ]);
}
// Removes private refs a cancelled or timed-out call left behind: those named
// <ms>-<uuid> and older than an hour. A recent one may belong to a running call.
async function sweepPrivateRefs(
  executor: ProcessService,
  git: Parameters<ProcessService["run"]>[0],
  cwd: string,
  env: Readonly<Record<string, string>>,
  now: number,
): Promise<void> {
  const listed = await bestEffortGit(executor, git, cwd, env, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/forge/lane-close/",
    "refs/forge/lane-base/",
  ]);
  const stale = listed.split(/\r?\n/).filter((ref) => {
    const match = PRIVATE_REF.exec(ref);
    return match !== null && now - Number(match[1]) > PRIVATE_REF_MAX_AGE_MS;
  });
  await dropPrivateRefs(executor, git, cwd, env, stale);
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
    rebuild?: { exitCode: number; argv?: string[] };
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
  target: string,
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
      target,
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
async function tailNext(call: HandlerCall<TailInput>): Promise<TailAction> {
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
  const linkUrl = links.at(-1)?.url;
  const pull = await readPull(
    call,
    bound,
    files.root,
    saved?.url ??
      (linkUrl !== undefined && linked === pr ? linkUrl : String(pr)),
  );
  if (typeof pull === "string")
    return pause(
      `GitHub returned data for PR #${pr} that Forge cannot read`,
      "Check the PR by hand and tell me what to do.",
      pull,
    );
  if (pull.state === "OPEN" && !saved)
    return await mergeNext(call, {
      issue: issue.id,
      id,
      pr,
      linked,
      pull,
      state,
      files,
    });
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
    journal = JSON.parse(JSON.stringify(saved)) as Journal;
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
            link.url.replace(/\/+$/, "") === journal.url.replace(/\/+$/, "") &&
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
    if (built && canonical(built.argv ?? null) !== canonical(rebuild.argv))
      return pause(
        "The rebuild command changed after it was recorded",
        "Run the configured rebuild again and record its exit code.",
        { recorded: built.argv ?? null, configured: rebuild.argv },
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
/*
 * Lane autopilot, merge step (forge-885 S4). While the PR is OPEN, `lane.next` re-reads every merge
 * condition from GitHub (never from the journal or an agent) and returns the merge action only when
 * all hold and a MERGE verdict is recorded for this exact head. The action is `forge pr merge`, which
 * runs the full gate again (receipt and door paths included) and pins squash and --match-head-commit.
 * Anything it cannot read, and a head that moved while it read, pauses.
 */
const MERGE_KEY = (id: string): string => `autopilot-merge:${id}`;
const CODEX_REVIEWER = "chatgpt-codex-connector[bot]";
const REVIEWER = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;
// Code defaults: the runtime only applies top-level schema defaults, so a nested key can be absent.
// Manifests and lock files match by file name at any depth (MANIFEST_FILE), not by one toolchain.
const DEFAULT_SECURITY_PATHS = [
  ".github/workflows",
  "src/core/trust",
  "src/adapters/fs",
  "src/adapters/process",
  "src/assembly/providers.ts",
  "templates/delivery",
];
const MANIFEST_FILE =
  /^(?:package\.json|[a-z]+\.lockb?|[a-z]+-lock\.(?:json|ya?ml)|[a-z]+-shrinkwrap\.json)$/;
const MERGE_QUERY =
  "query($owner:String!,$repo:String!,$n:Int!,$head:GitObjectID!){repository(owner:$owner,name:$repo){object(oid:$head){... on Commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:$n)} ... on StatusContext{context state isRequired(pullRequestNumber:$n)}}}}}} pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}";
type MergeVerdict = {
  head: string;
  verdict: "MERGE" | "FIX";
  reviewer: string;
  at: string;
};
type MergeSettings = {
  readonly enabled?: boolean;
  readonly headReviewers?: readonly string[];
  readonly requiredChecks?: "github-required" | readonly string[];
  readonly securityLabels?: readonly string[];
  readonly securityPaths?: readonly string[];
};
class Unreadable extends Error {}
class HeadMoved extends Error {}
/** The PR is in another repository or host than this project; never merged automatically. */
class ForeignRepo extends Error {}
function parseJson(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Unreadable(`${what} is not JSON: ${text.slice(0, 200)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Unreadable(`${what} is not an object`);
  return value as Record<string, unknown>;
}
const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
/** A stored verdict is trusted only when every field is present and well formed. */
function validVerdict(row: unknown): row is MergeVerdict {
  return (
    isMap(row) &&
    Object.keys(row).sort().join(",") === "at,head,reviewer,verdict" &&
    isCommit(row.head) &&
    (row.verdict === "MERGE" || row.verdict === "FIX") &&
    typeof row.reviewer === "string" &&
    row.reviewer.trim() !== "" &&
    typeof row.at === "string" &&
    Number.isFinite(Date.parse(row.at))
  );
}
/** Compare security paths the way a case-insensitive checkout sees them. */
const securityForm = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
async function readMergeFacts(
  call: { signal: AbortSignal; deadline: number },
  bound: { process?: ProcessService; environment?: EnvironmentService },
  cwd: string,
  pr: number,
  url: string,
  head: string,
  settings: MergeSettings | undefined,
): Promise<{ reasons: string[]; labels: string[]; paths: string[] }> {
  if (!bound.process || !bound.environment)
    fail("UNAVAILABLE", "Lane next needs process and environment services");
  const proc = bound.process;
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
  const gh = proc.resolve("gh", env);
  if (gh.kind !== "resolved")
    fail("UNAVAILABLE", "Install gh and put it on PATH");
  const run = async (args: string[]): Promise<string> => {
    const remaining = call.deadline - Date.now();
    if (remaining <= 0)
      fail("INVOCATION_TIMEOUT", "Lane next deadline expired");
    const result = await proc.run(gh, args, {
      cwd,
      env,
      signal: call.signal,
      timeoutMs: Math.min(20000, remaining),
      maxOutputBytes: 65536,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.truncated ||
      (result.outputEvidence &&
        (!result.outputEvidence.stdout.complete ||
          !result.outputEvidence.stderr.complete))
    )
      throw new Unreadable(
        `gh ${args.slice(0, 2).join(" ")} did not finish (exit ${result.exitCode})`,
      );
    return result.stdout;
  };
  const where = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
  if (!where || Number(where[4]) !== pr)
    throw new Unreadable(`PR url ${url} is not a pull request url`);
  const [, host = "", owner = "", repo = ""] = where;
  // `forge pr merge <n>` acts on this project's repository, so a PR elsewhere is never merged here.
  const origin = (await run(["repo", "view", "--json", "url", "--jq", ".url"]))
    .trim()
    .replace(/(?:\.git)?\/*$/, "")
    .toLowerCase();
  if (origin !== `https://${host}/${owner}/${repo}`.toLowerCase())
    throw new ForeignRepo(
      `PR #${pr} is at https://${host}/${owner}/${repo}, this project is ${origin || "unknown"}`,
    );
  const reasons: string[] = [];
  const named = (rows: unknown, key: string): string[] => {
    if (!Array.isArray(rows)) throw new Unreadable(`PR ${key} list missing`);
    return rows.map((row) => {
      const value = isMap(row) ? row[key] : undefined;
      if (typeof value !== "string")
        throw new Unreadable(`PR ${key} entry is not a string`);
      return value;
    });
  };
  const view = parseJson(
    await run([
      "pr",
      "view",
      url,
      "--json",
      "headRefOid,baseRefOid,state,mergeStateStatus,labels,changedFiles",
    ]),
    "PR view",
  );
  const labels = named(view.labels, "name");
  if (
    !isCommit(view.headRefOid) ||
    !isCommit(view.baseRefOid) ||
    typeof view.state !== "string" ||
    typeof view.mergeStateStatus !== "string" ||
    typeof view.changedFiles !== "number" ||
    !Number.isInteger(view.changedFiles)
  )
    throw new Unreadable("PR view is missing facts");
  if (view.headRefOid.toLowerCase() !== head)
    throw new HeadMoved(`head is now ${view.headRefOid}`);
  if (view.state !== "OPEN" || view.mergeStateStatus !== "CLEAN")
    reasons.push(
      `merge state is ${view.state}/${view.mergeStateStatus}, not OPEN/CLEAN`,
    );
  // The files API names both sides of a rename; `gh pr view --json files` lists only the new path.
  const changed = (
    await run([
      "api",
      `repos/${owner}/${repo}/pulls/${pr}/files?per_page=100`,
      "--paginate",
      "--hostname",
      host,
      "--jq",
      ".[] | {f: .filename, p: .previous_filename} | @json",
    ])
  )
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseJson(line, "PR file"));
  const paths: string[] = [];
  for (const file of changed) {
    if (typeof file.f !== "string" || !file.f)
      throw new Unreadable("A changed file has no name");
    paths.push(file.f);
    if (typeof file.p === "string" && file.p) paths.push(file.p);
    else if (file.p !== null && file.p !== undefined)
      throw new Unreadable("A changed file has a malformed previous name");
  }
  if (changed.length !== view.changedFiles)
    throw new Unreadable(
      `PR lists ${view.changedFiles} changed files but the files API returned ${changed.length}`,
    );
  const ancestry = (
    await run([
      "api",
      `repos/${owner}/${repo}/compare/${view.baseRefOid}...${head}`,
      "--hostname",
      host,
      "--jq",
      ".status",
    ])
  ).trim();
  if (ancestry !== "ahead" && ancestry !== "identical")
    reasons.push(
      `branch does not contain the current base branch tip (compare status: ${ancestry || "unknown"})`,
    );
  const graph = parseJson(
    await run([
      "api",
      "graphql",
      "--hostname",
      host,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `n=${pr}`,
      "-F",
      `head=${head}`,
      "-f",
      `query=${MERGE_QUERY}`,
    ]),
    "GraphQL answer",
  );
  const data = graph.errors === undefined ? graph.data : null;
  const repository = (data as { repository?: unknown } | null)?.repository as
    | {
        object?: {
          statusCheckRollup?: {
            contexts?: { pageInfo?: unknown; nodes?: unknown };
          } | null;
        } | null;
        pullRequest?: {
          reviewThreads?: { pageInfo?: unknown; nodes?: unknown };
        };
      }
    | undefined;
  const contexts = repository?.object?.statusCheckRollup?.contexts;
  const threads = repository?.pullRequest?.reviewThreads;
  const more = (info: unknown): boolean =>
    !isMap(info) || info.hasNextPage !== false;
  if (
    !repository?.object ||
    !threads ||
    !Array.isArray(threads.nodes) ||
    more(threads.pageInfo) ||
    (contexts !== undefined &&
      (!Array.isArray(contexts.nodes) || more(contexts.pageInfo)))
  )
    throw new Unreadable(
      "GitHub checks or review threads are missing or have more than one page",
    );
  // Required checks follow the same rule as check.gate: GitHub's required flag, or a named list.
  const wanted = settings?.requiredChecks ?? "github-required";
  const seen = new Set<string>();
  let required = 0;
  for (const node of listOf(contexts?.nodes)) {
    if (!isMap(node)) throw new Unreadable("A check entry is not an object");
    if (typeof node.isRequired !== "boolean")
      throw new Unreadable("A check does not say whether it is required");
    const isRun = node.__typename === "CheckRun";
    const name = isRun ? node.name : node.context;
    const shown =
      isRun && node.status === "COMPLETED"
        ? node.conclusion
        : (node.state ?? node.status);
    if (typeof name !== "string" || typeof shown !== "string")
      throw new Unreadable("A check has no name or state");
    seen.add(name);
    if (
      wanted === "github-required" ? !node.isRequired : !wanted.includes(name)
    )
      continue;
    required++;
    if (shown !== "SUCCESS")
      reasons.push(`required check ${name} is ${shown}, not SUCCESS`);
  }
  if (wanted !== "github-required")
    for (const name of wanted)
      if (!seen.has(name)) reasons.push(`required check ${name} is absent`);
  if (!required) reasons.push("no required checks were found on the head");
  let open = 0;
  for (const node of listOf(threads.nodes)) {
    if (!isMap(node) || typeof node.isResolved !== "boolean")
      throw new Unreadable("A review thread entry is not readable");
    if (!node.isResolved) open++;
  }
  if (open) reasons.push(`${open} unresolved review thread(s)`);
  // An omitted list means the Codex connector; an empty list is never a way to skip the review.
  const reviewers = settings?.headReviewers ?? [CODEX_REVIEWER];
  if (!reviewers.length)
    throw new Unreadable(
      "No head reviewers are configured; an empty list does not skip the head review",
    );
  for (const login of reviewers) {
    if (!REVIEWER.test(login))
      throw new Unreadable(`reviewer login ${login} is not a valid login`);
    // GitHub logins are case-insensitive.
    const lines = (
      await run([
        "api",
        `repos/${owner}/${repo}/issues/${pr}/comments`,
        "--paginate",
        "--hostname",
        host,
        "--jq",
        `.[] | select((.user.login | ascii_downcase) == "${login.toLowerCase()}") | .body | split("\\n")[] | select(contains("codex-review-state:v1"))`,
      ])
    )
      .split("\n")
      .flatMap((line) => {
        const text = /codex-review-state:v1 (\{.*\})/.exec(line)?.[1];
        return text === undefined ? [] : [text];
      });
    // Only state lines that name this head count; two different results for it conflict.
    const mine: { done: boolean; clean: boolean }[] = [];
    for (const text of lines) {
      try {
        const value: unknown = JSON.parse(text);
        const review =
          isMap(value) && isMap(value.code_review)
            ? value.code_review
            : undefined;
        if (
          typeof review?.commit_sha === "string" &&
          review.commit_sha.toLowerCase() === head
        )
          mine.push({
            done: review.status === "completed",
            // A clean review says false; true, null or a missing field is not clean.
            clean: review.has_unresolved_findings === false,
          });
      } catch {
        // A line that is not JSON names no head.
      }
    }
    const first = mine[0];
    if (!first || !first.done) reasons.push(`head review missing: ${login}`);
    else if (
      mine.some((row) => row.done !== first.done || row.clean !== first.clean)
    )
      reasons.push(`head review conflicts: ${login}`);
    else if (!first.clean)
      reasons.push(`head review has unresolved findings: ${login}`);
  }
  // The fresh read: the head must not have moved, and a label added since the first read counts.
  const after = parseJson(
    await run(["pr", "view", url, "--json", "headRefOid,labels"]),
    "PR head",
  );
  if (
    typeof after.headRefOid !== "string" ||
    after.headRefOid.toLowerCase() !== head
  )
    throw new HeadMoved(`head is now ${String(after.headRefOid)}`);
  return {
    reasons,
    labels: [...new Set([...labels, ...named(after.labels, "name")])],
    paths,
  };
}
async function mergeNext(
  call: HandlerCall<TailInput>,
  at: {
    issue: string;
    id: string;
    pr: number;
    linked: number;
    pull: TailPull;
    state: LeaseStateClient;
    files: FilesService;
  },
): Promise<TailAction> {
  const { input, services, config } = call;
  const { issue, id, pr, pull, state, files } = at;
  const settings = (config as WorkConfig | undefined)?.lanes?.autopilot?.merge;
  const head = pull.headRefOid.toLowerCase();
  const action = (
    kind: TailAction["kind"],
    why: string,
    expect: string,
    extra: Partial<TailAction> = {},
  ): TailAction => ({
    lane: issue,
    step: "merge",
    n: 0,
    kind,
    why,
    expect,
    budget: { actions: 0, records: 0 },
    ...extra,
  });
  const pause = (why: string, ask: string, raw: unknown): TailAction => {
    const quoted = typeof raw === "string" ? raw : JSON.stringify(raw);
    emit(state, id, "pause", { why, raw: quoted });
    return action("pause", why, "an owner reply; Forge guesses nothing", {
      ask,
      raw: quoted,
    });
  };
  const moved = (detail: string): TailAction =>
    pause(
      `HEAD_MOVED: ${detail}`,
      "The PR head moved while Forge checked it. Review the new head, record a merge-gate verdict for it, then run lane next again.",
      { checked: head, detail },
    );
  // The PR and its branch must belong to this lane before anything else is read.
  const lane = laneRegistry(files).lanes.find(
    (row) => laneIdentity(row) === id,
  );
  if (!lane)
    return pause(
      `No recorded lane for ${issue}`,
      "This lane has no registry entry, so Forge cannot tell this PR belongs to it. Tell me what to do.",
      { issue },
    );
  if (lane.branch !== pull.headRefName)
    return pause(
      `PR #${pr} is on ${pull.headRefName} but the lane is on ${lane.branch}`,
      "The PR is on a different branch than the lane. Check it and tell me what to do.",
      { lane: lane.branch, pr: pull.headRefName },
    );
  if (at.linked !== 0 && at.linked !== pr)
    return pause(
      `${issue} delivers PR #${at.linked} but PR #${pr} was asked about`,
      "The PR does not match the lane's delivers link. Tell me which PR this lane lands.",
      { linked: at.linked, asked: pr },
    );
  if (input.head !== undefined && input.head.toLowerCase() !== head)
    return moved(`pinned ${input.head} but the PR head is ${head}`);
  let facts: Awaited<ReturnType<typeof readMergeFacts>>;
  try {
    facts = await readMergeFacts(
      call,
      services as {
        process?: ProcessService;
        environment?: EnvironmentService;
      },
      files.root,
      pr,
      pull.url,
      head,
      settings,
    );
  } catch (error) {
    if (error instanceof HeadMoved) return moved(error.message);
    if (error instanceof ForeignRepo)
      return pause(
        error.message,
        "This PR is in another repository or host. Cross-repo merges are never automatic: merge it yourself or tell me what to do.",
        { url: pull.url },
      );
    if (!(error instanceof Unreadable)) throw error;
    return pause(
      `Forge could not read the merge facts for PR #${pr}`,
      "Check the PR by hand and tell me what to do.",
      error.message,
    );
  }
  // Pauses that need a person come before waits that only need time.
  const labels = (settings?.securityLabels ?? ["security"]).map((name) =>
    name.toLowerCase(),
  );
  const configured = settings?.securityPaths;
  const folders = (configured ?? DEFAULT_SECURITY_PATHS)
    .map(securityForm)
    .filter(Boolean);
  const label = facts.labels.find((name) =>
    labels.includes(name.toLowerCase()),
  );
  const path = facts.paths.find((file) => {
    const form = securityForm(file);
    return (
      folders.some((entry) => form === entry || form.startsWith(`${entry}/`)) ||
      (configured === undefined &&
        MANIFEST_FILE.test(form.slice(form.lastIndexOf("/") + 1)))
    );
  });
  if (label !== undefined || path !== undefined)
    return pause(
      `PR #${pr} is security tier (${label !== undefined ? `label ${label}` : `path ${path}`})`,
      "A security PR is merged by the owner. Review it and merge it yourself, or tell me to go ahead.",
      { label: label ?? null, path: path ?? null },
    );
  const row = state.get(MERGE_KEY(id))?.value;
  if (row !== undefined) {
    if (!validVerdict(row))
      return pause(
        "The stored merge-gate verdict is malformed",
        "Record the verdict again for the current head.",
        row,
      );
    if (row.head.toLowerCase() !== head)
      return pause(
        `The merge-gate verdict is for ${row.head}, not the current head ${head}`,
        "Run the merge-gate review on the current head and record its verdict.",
        row,
      );
    if (row.verdict !== "MERGE")
      return pause(
        `The merge-gate verdict for head ${head} is ${row.verdict}`,
        "The reviewer asked for fixes. Fix them and record a new verdict, or tell me what to do.",
        row,
      );
  }
  if (facts.reasons.length)
    return action(
      "wait",
      `The merge gate refuses PR #${pr}: ${facts.reasons.join("; ")}`,
      `every merge condition true on head ${head}`,
    );
  if (row === undefined)
    return action(
      "wait",
      `No merge-gate verdict is recorded for head ${head}`,
      `a verdict from the merge-gate reviewer, recorded with: forge lane record --input '{"id":"${issue}","mergeGate":{"head":"${head}","verdict":"<MERGE|FIX>","reviewer":"<who>"}}'. Record only the verdict the merge-gate reviewer gave; never your own.`,
    );
  // lane.record cannot tell which session records a verdict, so a verdict is not yet trustworthy.
  if (settings?.enabled !== true)
    return pause(
      `Every merge condition holds on head ${head}, but the merge action is switched off`,
      "Merge PR #" +
        pr +
        " by hand, or set blocks.work.config.lanes.autopilot.merge.enabled to true once a trusted verdict channel exists.",
      { enabled: settings?.enabled ?? false },
    );
  emit(state, id, "merge-action", { pr, head });
  return action(
    "forge",
    `Every merge condition holds on head ${head} and a MERGE verdict is recorded for it. Run this: it runs the full gate again, squash merges with --match-head-commit ${head} and reads the result back. Never run raw gh pr merge.`,
    `outcome MERGED for head ${head}; any other outcome stops the lane`,
    { argv: ["forge", "pr", "merge", String(pr), "--head", head] },
  );
}
/*
 * Lane autopilot guardrails (forge-885 S2). Every limit is config with a default. `lane.next`
 * checks the switch, the stop flag and the lane's budgets before it reads anything, and a lane
 * it cannot decide pauses. The global state lives at `autopilot:global`.
 */
type Channel = { harness: string; thread: string };
type GlobalState = {
  stopAll?: string;
  stopped: Record<string, string>;
  resumed?: { at: string; scope: string; quote?: string };
  owner?: {
    channel: Channel;
    /** The last message number sent; it only grows, even if the channel changes. */
    seq?: number;
    sentAt?: string;
    batch?: { seq: number; items: string[]; replied?: true };
    clarify?: string;
    /** The clarifying question is the all-or-nothing one for a resume after stop-all. */
    allOrNothing?: true;
  };
};
const GLOBAL = "autopilot:global";
const DEFAULT_LIMITS = {
  calls: 20,
  reviewRounds: 2,
  ciFixRounds: 3,
  activeHours: 8,
  minFreeMemoryMb: 2048,
  maxCpuPercent: 85,
  lanes: 3,
};
function limitsOf(config: unknown) {
  const lanes = (config as WorkConfig | undefined)?.lanes;
  const settings = lanes?.autopilot;
  return {
    enabled: settings?.enabled !== false,
    calls: settings?.budgets?.calls ?? DEFAULT_LIMITS.calls,
    reviewRounds:
      settings?.budgets?.reviewRounds ?? DEFAULT_LIMITS.reviewRounds,
    ciFixRounds: settings?.budgets?.ciFixRounds ?? DEFAULT_LIMITS.ciFixRounds,
    activeHours: settings?.budgets?.activeHours ?? DEFAULT_LIMITS.activeHours,
    minFreeMemoryMb:
      settings?.load?.minFreeMemoryMb ?? DEFAULT_LIMITS.minFreeMemoryMb,
    maxCpuPercent:
      settings?.load?.maxCpuPercent ?? DEFAULT_LIMITS.maxCpuPercent,
    lanes: lanes?.max ?? DEFAULT_LIMITS.lanes,
  };
}
type Limits = ReturnType<typeof limitsOf>;
/** A stored autopilot record that is present but unreadable. Only an absent record gets defaults. */
class StateProblem extends Error {
  readonly global: boolean;
  constructor(what: string, global = false) {
    super(`Stored autopilot state is malformed: ${what}`);
    this.global = global;
  }
}
const isTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function readGlobal(state: LeaseStateClient): {
  value: GlobalState;
  revision: number;
} {
  const record = state.get(GLOBAL);
  if (!record) return { value: { stopped: {} }, revision: 0 };
  const value = record.value as Record<string, unknown> | null;
  if (!isMap(value))
    throw new StateProblem("autopilot:global is not an object", true);
  const { stopAll, stopped, resumed } = value;
  if (stopAll !== undefined && !isTime(stopAll))
    throw new StateProblem("autopilot:global stopAll is not a time", true);
  if (!isMap(stopped) || !Object.values(stopped).every(isTime))
    throw new StateProblem(
      "autopilot:global stopped is missing or not a map of times",
      true,
    );
  if (resumed !== undefined && !isMap(resumed))
    throw new StateProblem("autopilot:global resumed is not an object", true);
  if (value.owner !== undefined && !validOwner(value.owner))
    throw new StateProblem("autopilot:global owner is malformed", true);
  return {
    value: value as unknown as GlobalState,
    revision: record.revision,
  };
}
/** A sample counts only when both numbers are finite and in range. */
function validLoad(load: unknown): load is Load {
  const sample = load as Partial<Load> | null | undefined;
  return (
    typeof sample?.freeMemoryMb === "number" &&
    Number.isFinite(sample.freeMemoryMb) &&
    sample.freeMemoryMb >= 0 &&
    typeof sample.cpuBusyPercent === "number" &&
    Number.isFinite(sample.cpuBusyPercent) &&
    sample.cpuBusyPercent >= 0 &&
    sample.cpuBusyPercent <= 100
  );
}
/**
 * Whether a new lane may start, from the running count and a load sample. Pure, so tests inject
 * the numbers. An unmeasured load holds the start: unknown means no.
 */
function startDecision(
  running: number,
  limits: Limits,
  load: Load | undefined,
): { start: true } | { start: false; reason: string } {
  if (running >= limits.lanes)
    return {
      start: false,
      reason: `lane cap ${limits.lanes} reached (${running} running)`,
    };
  if (!validLoad(load))
    return { start: false, reason: "machine load cannot be measured" };
  if (load.freeMemoryMb < limits.minFreeMemoryMb)
    return {
      start: false,
      reason: `free memory ${load.freeMemoryMb} MB is under ${limits.minFreeMemoryMb} MB`,
    };
  if (load.cpuBusyPercent > limits.maxCpuPercent)
    return {
      start: false,
      reason: `CPU ${load.cpuBusyPercent}% is over ${limits.maxCpuPercent}%`,
    };
  return { start: true };
}
const clockKey = (id: string): string => `autopilot-clock:${id}`;
function clockOf(state: LeaseStateClient, id: string): number | undefined {
  const record = state.get(clockKey(id));
  if (!record) return undefined;
  const at = (record.value as { startedAt?: unknown } | null)?.startedAt;
  if (!isTime(at))
    throw new StateProblem(`${clockKey(id)} has no valid startedAt`);
  return Date.parse(at);
}
/** What a lane has used. Review and CI rounds count from the journal once a loop writes them. */
function usageOf(
  state: LeaseStateClient,
  ids: Ids,
  id: string,
  limits: Limits,
) {
  const journal = state.get(journalKey(id))?.value as
    (Journal & { rounds?: { review?: unknown; ci?: unknown } }) | undefined;
  if (
    journal !== undefined &&
    (!isMap(journal) ||
      typeof journal.step !== "string" ||
      !isCount(journal.pr) ||
      !isMap(journal.counters) ||
      !isCount(journal.counters.actions) ||
      !isCount(journal.counters.records))
  )
    throw new StateProblem(`${journalKey(id)} is missing required fields`);
  const rounds = journal?.rounds;
  if (
    rounds !== undefined &&
    (!isMap(rounds) ||
      (rounds.review !== undefined && !isCount(rounds.review)) ||
      (rounds.ci !== undefined && !isCount(rounds.ci)))
  )
    throw new StateProblem(`${journalKey(id)} rounds are not counts`);
  const clock = clockOf(state, id);
  const activeMs = clock === undefined ? 0 : Math.max(0, state.now() - clock);
  return {
    journal,
    calls: {
      used: callBudget(state, ids, ids.shown(id)).used,
      limit: limits.calls,
    },
    // Compared in milliseconds against the exact limit; hours are rounded only for display.
    activeMs,
    activeHours: {
      used: Math.round((activeMs / 3600_000) * 100) / 100,
      limit: limits.activeHours,
    },
    rounds: {
      review: {
        used: (rounds?.review as number | undefined) ?? 0,
        limit: limits.reviewRounds,
      },
      ci: {
        used: (rounds?.ci as number | undefined) ?? 0,
        limit: limits.ciFixRounds,
      },
    },
  };
}
function guardPause(
  lane: string,
  why: string,
  ask: string,
  raw: unknown,
): TailAction {
  return {
    lane,
    step: "guard",
    n: 0,
    kind: "pause",
    why,
    expect: "an owner reply; Forge guesses nothing",
    budget: { actions: 0, records: 0 },
    ask,
    raw: typeof raw === "string" ? raw : JSON.stringify(raw),
  };
}
async function guardedNext(
  call: HandlerCall<NextInput>,
  id: string,
): Promise<TailAction> {
  const { input, services, config } = call;
  const state = client(services),
    ids = idsFor(state, config),
    shown = ids.shown(id),
    limits = limitsOf(config);
  if (!limits.enabled) {
    const off = guardPause(
      shown,
      "Lane autopilot is switched off in config",
      "Set blocks.work.config.lanes.autopilot.enabled to true to run lanes again.",
      { enabled: false },
    );
    pauseMeta.set(off, { urgent: "kill-switch" });
    return off;
  }
  const unreadable = (error: unknown): TailAction => {
    if (!(error instanceof StateProblem)) throw error;
    return guardPause(
      shown,
      error.message,
      "Forge cannot trust this stored state, so the lane stays paused. Repair or remove the record, then run lane next again.",
      error.message,
    );
  };
  let flags: GlobalState;
  try {
    flags = readGlobal(state).value;
  } catch (error) {
    return unreadable(error);
  }
  const stoppedAt = flags.stopAll ?? flags.stopped[id];
  if (stoppedAt !== undefined) {
    const stopped = guardPause(
      shown,
      `Lanes were stopped at ${stoppedAt}`,
      "Resume with forge lane resume once you approve. Forge returns only pause until then.",
      { stopped: stoppedAt },
    );
    pauseMeta.set(stopped, {
      urgent: "kill-switch",
      gated: {
        op: "lane.resume",
        input: flags.stopAll !== undefined ? { all: true } : { id: shown },
      },
    });
    return stopped;
  }
  let used: ReturnType<typeof usageOf>;
  try {
    // An id that was never allocated must not leave a clock behind.
    get(state, id, shown);
    if (clockOf(state, id) === undefined)
      persist(
        state,
        clockKey(id),
        { startedAt: new Date(state.now()).toISOString() },
        0,
      );
    used = usageOf(state, ids, id, limits);
  } catch (error) {
    return unreadable(error);
  }
  const spent: [string, Usage, boolean][] = [
    ["calls", used.calls, used.calls.used >= used.calls.limit],
    [
      "active hours",
      used.activeHours,
      used.activeMs >= used.activeHours.limit * 3600_000,
    ],
    [
      "review rounds",
      used.rounds.review,
      used.rounds.review.used >= used.rounds.review.limit,
    ],
    [
      "CI fix rounds",
      used.rounds.ci,
      used.rounds.ci.used >= used.rounds.ci.limit,
    ],
  ];
  for (const [name, usage, over] of spent)
    if (over)
      return guardPause(
        shown,
        `${shown} used up its ${name} budget`,
        `${shown} has used its ${name} budget (limit ${usage.limit}, used ${usage.used}). Raise blocks.work.config.lanes.autopilot.budgets or stop the lane; Forge waits for your reply.`,
        { budget: name, ...usage },
      );
  return await tailNext({ ...call, input: { ...input, id: shown } });
}
/** The step and PR a lane recorded before any post-merge journal exists. */
function beforeMerge(
  state: LeaseStateClient,
  id: string,
): { step?: string; pr?: number } {
  const step = recovery(appended(state, `comment:${id}:`))?.step;
  const url = appended(state, `link:${id}:`)
    .map((row) => row.value as LinkInput)
    .filter((link) => link.relation === "delivers")
    .at(-1)?.url;
  const pr = Number(/\/pull\/(\d+)\/?$/.exec(url ?? "")?.[1] ?? 0);
  return { ...(step ? { step } : {}), ...(pr ? { pr } : {}) };
}
/**
 * Every lane that still needs attention: the registered lanes, plus any lane whose autopilot
 * journal is not at done. Lane close removes a lane from the registry before the tail ends.
 * A journal that cannot be read is listed too, so its pause shows.
 */
function activeLanes(state: LeaseStateClient, files: FilesService): string[] {
  const found = laneRegistry(files).lanes.map(laneIdentity);
  for (const row of state.list("autopilot:")) {
    const id = row.key.slice("autopilot:".length);
    if (!/^work-\d+$/.test(id) || found.includes(id)) continue;
    const value = row.value as { step?: unknown } | null;
    if (!isMap(value) || value.step !== "done") found.push(id);
  }
  return found;
}
/*
 * Lane autopilot, owner channel (forge-885 S3). Every pause becomes one queued ask per lane. One
 * session, the owner channel, gets the asks as a single numbered message at most every 30 minutes
 * (a kill-switch trip goes at once). The owner's reply is recorded verbatim and mapped to a label
 * per item; anything else keeps every lane paused. Silence never applies a default.
 */
const ASK = (id: string): string => `autopilot-ask:${id}`;
const OWNER_WINDOW_MS = 30 * 60_000;
type AskOption = {
  label: string;
  text: string;
  hold?: true;
  approve?: true;
};
type Gate = {
  op: string;
  input: Record<string, unknown>;
  request?: string;
};
type Approval = { request: string; quote: string; source: ReplySource };
type Ask = {
  lane: string;
  issue: string;
  title: string;
  reason: string;
  options: AskOption[];
  default: string;
  urgent?: string;
  gated?: Gate;
  queuedAt: string;
  status: "queued" | "sent" | "answered" | "held" | "done";
  batch?: number;
  n?: number;
  answer?: {
    label: string;
    quote: string;
    source: ReplySource;
    at: string;
    approval?: Approval;
  };
};
const GENERIC: AskOption[] = [
  { label: "A", text: "carry on, I dealt with the cause or accept it" },
  { label: "B", text: "park the lane and file what is left" },
  { label: "C", text: "I will look myself, keep it paused", hold: true },
];
const RESUME: AskOption[] = [
  { label: "A", text: "resume it (your reply is the approval)", approve: true },
  { label: "B", text: "keep it stopped", hold: true },
];
/** Facts a pause carries that its action shape cannot: urgency and the gated step it waits on. */
const pauseMeta = new WeakMap<TailAction, { urgent?: string; gated?: Gate }>();
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isChannel = (value: unknown): value is Channel =>
  isMap(value) && nonEmpty(value.harness) && nonEmpty(value.thread);
function validOwner(value: unknown): boolean {
  if (!isMap(value) || !isChannel(value.channel)) return false;
  const { sentAt, batch, clarify } = value;
  return (
    (value.seq === undefined || isCount(value.seq)) &&
    (sentAt === undefined || isTime(sentAt)) &&
    (clarify === undefined || typeof clarify === "string") &&
    (value.allOrNothing === undefined || value.allOrNothing === true) &&
    (batch === undefined ||
      (isMap(batch) &&
        isCount(batch.seq) &&
        Array.isArray(batch.items) &&
        batch.items.every(nonEmpty) &&
        (batch.replied === undefined || batch.replied === true)))
  );
}
function validAsk(value: unknown): value is Ask {
  if (!isMap(value)) return false;
  const { gated, answer } = value;
  const options = Array.isArray(value.options)
    ? (value.options as Record<string, unknown>[])
    : undefined;
  return (
    nonEmpty(value.lane) &&
    nonEmpty(value.issue) &&
    typeof value.title === "string" &&
    nonEmpty(value.reason) &&
    isTime(value.queuedAt) &&
    ["queued", "sent", "answered", "held", "done"].includes(
      value.status as string,
    ) &&
    options !== undefined &&
    options.length >= 2 &&
    options.every(
      (option) =>
        isMap(option) &&
        /^[A-Z]$/.test(option.label as string) &&
        nonEmpty(option.text),
    ) &&
    options.some((option) => option.label === value.default) &&
    (gated === undefined ||
      (isMap(gated) &&
        nonEmpty(gated.op) &&
        isMap(gated.input) &&
        (gated.request === undefined || nonEmpty(gated.request)))) &&
    (answer === undefined || isMap(answer)) &&
    (value.batch === undefined || isCount(value.batch)) &&
    (value.n === undefined || isCount(value.n))
  );
}
type AskRow = { value: Ask; revision: number };
function readAsk(state: LeaseStateClient, id: string): AskRow | undefined {
  const record = state.get(ASK(id));
  if (!record) return undefined;
  if (!validAsk(record.value))
    throw new StateProblem(`${ASK(id)} is not a valid ask`);
  return { value: record.value, revision: record.revision };
}
function saveAsk(state: LeaseStateClient, ask: Ask, revision: number): AskRow {
  const written = persist(state, ASK(ask.lane), ask, revision);
  return { value: ask, revision: written.revision };
}
/** Held or answered: the owner has spoken about this reason, so it is not asked again. */
const settledAsk = (ask: Ask): boolean =>
  ask.status === "held" || ask.status === "answered";
const heldAsk = (ask: Ask | undefined): boolean => ask?.status === "held";
const openAsk = (ask: Ask | undefined): boolean =>
  ask?.status === "queued" || ask?.status === "sent";
/**
 * Who is calling, in the same terms as src/assembly/identity.ts (a block cannot import it). A
 * session with no identity cannot be the owner channel and gets plain pauses as before.
 */
function channelOf(services: unknown): Channel | undefined {
  let env: Readonly<Record<string, string>> = {};
  try {
    env =
      (
        services as { environment?: Partial<EnvironmentService> }
      ).environment?.select?.([
        "FORGE_SESSION",
        "FORGE_HARNESS",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
        "CLAUDE_CODE_SESSION_ID",
      ]) ?? {};
  } catch {
    return undefined;
  }
  const value = (name: string) => env[name]?.trim() || undefined;
  const codex = value("CODEX_SESSION_ID") ?? value("CODEX_THREAD_ID");
  const claude = value("CLAUDE_CODE_SESSION_ID");
  const natives: [string, string][] = [];
  if (codex) natives.push(["codex", codex]);
  if (claude) natives.push(["claude-code", claude]);
  const thread =
    value("FORGE_SESSION") ??
    (natives.length
      ? natives
          .map(([name, id]) => `${name}:${encodeURIComponent(id)}`)
          .join("+")
      : undefined);
  const harness =
    value("FORGE_HARNESS") ??
    (natives.length > 1
      ? "codex+claude-code"
      : (natives[0]?.[0] ?? "local-cli"));
  return thread === undefined ? undefined : { harness, thread };
}
/** The pause's own ask text is dropped: the owner hears only the composed message. */
function quiet(action: TailAction): TailAction {
  const { ask: _ask, ...rest } = action;
  return rest;
}
/** The owner already decided this pause: no ask text, no message, nothing written, until the lane changes. */
function settledAction(action: TailAction, ask: Ask): TailAction {
  return {
    ...quiet(action),
    step: "owner",
    kind: "pause",
    why: `${action.why}. The owner already answered${ask.answer ? ` ${ask.answer.label}` : ""}, so this is not asked again until the lane's state changes.`,
    expect:
      "nothing; the owner decided, so do not ask or message them about this again",
  };
}
const sameChannel = (a: Channel, b: Channel): boolean =>
  a.harness === b.harness && a.thread === b.thread;
const clip = (value: string, max = 200): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;
/** Merges and closes since the last message ride along as one line, never a message of their own. */
function digestLine(
  state: LeaseStateClient,
  ids: Ids,
  since: string | undefined,
): string {
  const done = state
    .list("autopilot-event:")
    .map(
      (row) =>
        row.value as {
          id?: string;
          type?: string;
          at?: string;
          detail?: { pr?: number };
        },
    )
    .filter(
      (event) =>
        event.type === "done" &&
        nonEmpty(event.id) &&
        isTime(event.at) &&
        (since === undefined || Date.parse(event.at) > Date.parse(since)),
    )
    .map((event) => `${ids.shown(event.id!)} (#${event.detail?.pr ?? "?"})`);
  if (!done.length) return "";
  const shown = done.slice(0, 5).join(", ");
  return `Merged and closed since my last message: ${shown}${done.length > 5 ? ` and ${done.length - 5} more` : ""}.`;
}
function composeMessage(
  seq: number,
  items: Ask[],
  digest: string,
  clarify: string | undefined,
  allOrNothing = false,
): string {
  const lines = [
    clarify === undefined
      ? `Message #${seq}. Lanes need you (${items.length}):`
      : allOrNothing
        ? `Message #${seq}. Resuming after a stop of every lane is all or nothing, so I resumed nothing for "${clip(clarify, 80)}". Answer A for every lane to resume them all, or B for every lane to keep them stopped:`
        : `Message #${seq}. I could not tell which option you chose for each item in "${clip(clarify, 80)}". Answer once per item:`,
  ];
  items.forEach((ask, index) =>
    lines.push(
      `${index + 1}. ${ask.issue} "${clip(ask.title, 80)}": ${clip(ask.reason, 240).replace(/[.\s]+$/, "")}. ${ask.options.map((option) => `${option.label}) ${option.text}`).join(", ")}. Default ${ask.default}.`,
    ),
  );
  lines.push(
    `Reply with this message's number, like "#${seq} 1A 2B", or "#${seq} ok" to take every default. A reply to an older message is refused. If you do not reply, every lane stays paused.`,
  );
  if (digest) lines.push(digest);
  return lines.join("\n");
}
/**
 * One label per item, or nothing. "ok" and "defaults" take every default. Any other text, a missing
 * item, a repeated item or a label the item does not offer maps to nothing.
 */
function mapReply(reply: string, items: Ask[]): string[] | undefined {
  const said = reply.trim();
  if (/^(?:ok|okay|defaults?)[\s.!]*$/i.test(said))
    return items.map((ask) => ask.default);
  const labels: (string | undefined)[] = items.map(() => undefined);
  const tokens = said
    .replace(/(\d)\s+([A-Za-z])(?![A-Za-z0-9])/g, "$1$2")
    .split(/[\s,;]+/)
    .filter((token) => token && !/^(?:and|&)$/i.test(token));
  if (!tokens.length) return undefined;
  for (const token of tokens) {
    const match = /^(\d{1,3})[.:)-]?([A-Za-z])$/.exec(token);
    const at = match ? Number(match[1]) - 1 : -1;
    if (!match || at < 0 || at >= items.length || labels[at] !== undefined)
      return undefined;
    const label = match[2]!.toUpperCase();
    if (!items[at]!.options.some((option) => option.label === label))
      return undefined;
    labels[at] = label;
  }
  const chosen: string[] = [];
  for (const label of labels) {
    if (label === undefined) return undefined;
    chosen.push(label);
  }
  return chosen;
}
const LEADING_NUMBER = /^#(\d{1,9})(?!\w)/;
/** The message a reply answers: a leading "#<n>" token, or source.message "#<n>"; any other "#<n>" is plain text. */
function messageNumber(quote: string, source: ReplySource): number | undefined {
  const found: number[] = [];
  const leading = LEADING_NUMBER.exec(quote);
  if (leading) found.push(Number(leading[1]));
  const named = /^#(\d{1,9})$/.exec(source.message?.trim() ?? "");
  if (named) found.push(Number(named[1]));
  return found.length > 0 && found.every((number) => number === found[0])
    ? found[0]
    : undefined;
}
/**
 * Turns the pauses a `lane.next` call found into owner asks and decides what each lane's caller
 * gets: the composed message, a wait, or a hand-off to the owner channel. A session with no
 * identity, or an unreadable record, keeps the plain pause actions.
 */
function ownerRoute(
  call: HandlerCall<NextInput>,
  actions: TailAction[],
): TailAction[] {
  const { services, config } = call;
  const state = client(services),
    ids = idsFor(state, config),
    channel = channelOf(services);
  if (channel === undefined) return actions;
  try {
    const now = state.now(),
      at = new Date(now).toISOString();
    let global = readGlobal(state);
    const saveGlobal = () => {
      global = {
        value: global.value,
        revision: persist(state, GLOBAL, global.value, global.revision)
          .revision,
      };
    };
    const current = new Map<string, Ask>();
    for (const action of actions) {
      const id = ids.stored(action.lane);
      const row = readAsk(state, id);
      if (action.kind !== "pause") {
        // The lane moved on, so a hold the owner chose for its old pause no longer applies.
        if (row && (openAsk(row.value) || heldAsk(row.value)))
          saveAsk(state, { ...row.value, status: "done" }, row.revision);
        continue;
      }
      if (
        row?.value.reason === action.why &&
        (openAsk(row.value) || settledAsk(row.value))
      ) {
        current.set(id, row.value);
        continue;
      }
      const meta = pauseMeta.get(action);
      const ask: Ask = {
        lane: id,
        issue: action.lane,
        title: stored(get(state, id, action.lane)).title,
        reason: action.why,
        options: meta?.gated ? RESUME : GENERIC,
        default: meta?.gated ? "B" : "C",
        ...(meta?.urgent ? { urgent: meta.urgent } : {}),
        ...(meta?.gated ? { gated: meta.gated } : {}),
        queuedAt: at,
        status: "queued",
      };
      saveAsk(state, ask, row?.revision ?? 0);
      current.set(id, ask);
    }
    if (!current.size) return actions;
    const owner = global.value.owner;
    // Nobody claims the channel by asking first: it is set only with the owner's approval.
    if (owner === undefined)
      return actions.map((action): TailAction =>
        current.get(ids.stored(action.lane)) === undefined
          ? action
          : settledAsk(current.get(ids.stored(action.lane))!)
            ? settledAction(action, current.get(ids.stored(action.lane))!)
            : {
                ...action,
                why: `${action.why}. The owner channel is not set, so this ask stays queued.`,
                ask: `Set the owner channel with forge lane record --input '{"ownerChannel":{"harness":"<owner chat harness>","thread":"<owner chat thread>"}}' (fill in the owner's chat harness and thread; Forge asks the owner to approve it). Then run lane next again.`,
              },
      );
    if (!sameChannel(owner.channel, channel))
      return actions.map((action): TailAction =>
        current.get(ids.stored(action.lane)) === undefined
          ? action
          : settledAsk(current.get(ids.stored(action.lane))!)
            ? settledAction(action, current.get(ids.stored(action.lane))!)
            : {
                ...quiet(action),
                step: "owner",
                kind: "hand-to-owner",
                why: `${action.why}. This session is not the owner channel (${owner.channel.harness}, ${owner.channel.thread}).`,
                expect:
                  "nothing from this session; hand this to the owner channel and stop",
              },
      );
    const open: Ask[] = [];
    let highest = 0;
    for (const row of state.list("autopilot-ask:")) {
      if (!validAsk(row.value))
        throw new StateProblem(`${row.key} is not a valid ask`);
      highest = Math.max(highest, row.value.batch ?? 0);
      if (openAsk(row.value)) open.push(row.value);
    }
    // A gated ask is sent only once it carries the request id the reply will be bound to.
    const ready = open
      .filter((ask) => !ask.gated || ask.gated.request !== undefined)
      .sort((a, b) =>
        a.queuedAt === b.queuedAt
          ? a.lane.localeCompare(b.lane)
          : a.queuedAt.localeCompare(b.queuedAt),
      );
    const last =
      owner.sentAt === undefined ? undefined : Date.parse(owner.sentAt);
    const due =
      owner.clarify !== undefined ||
      ready.some((ask) => ask.status === "queued" && ask.urgent) ||
      (ready.length > 0 &&
        (last === undefined || now - last >= OWNER_WINDOW_MS));
    const carrier = actions.find(
      (action) =>
        action.kind === "pause" &&
        ready.some((ask) => ask.lane === ids.stored(action.lane)),
    );
    let message: string | undefined;
    let seq = 0;
    if (due && carrier) {
      // A rebuilt global record must not restart numbering: asks remember the numbers they were sent in.
      seq = Math.max(owner.seq ?? owner.batch?.seq ?? 0, highest) + 1;
      message = composeMessage(
        seq,
        ready,
        digestLine(state, ids, owner.sentAt),
        owner.clarify,
        owner.allOrNothing === true,
      );
      for (const ask of ready) {
        const row = readAsk(state, ask.lane)!;
        const sent = saveAsk(
          state,
          { ...row.value, status: "sent", batch: seq },
          row.revision,
        );
        if (current.has(ask.lane)) current.set(ask.lane, sent.value);
      }
      owner.batch = { seq, items: ready.map((ask) => ask.lane) };
      owner.seq = seq;
      owner.sentAt = at;
      delete owner.clarify;
      delete owner.allOrNothing;
      saveGlobal();
    }
    const next =
      last === undefined ? at : new Date(last + OWNER_WINDOW_MS).toISOString();
    return actions.map((action): TailAction => {
      const ask = current.get(ids.stored(action.lane));
      if (action.kind !== "pause" || ask === undefined) return action;
      if (settledAsk(ask)) return settledAction(action, ask);
      if (ask.gated && ask.gated.request === undefined)
        return {
          ...quiet(action),
          kind: "forge",
          argv: [
            "forge",
            "lane",
            "resume",
            ...(ask.gated.input.all === true ? ["--all"] : [ask.issue]),
          ],
          why: `${action.why}. The owner's approval needs a request id first.`,
          expect: `Run this once without approval; it fails with APPROVAL_REQUIRED and a request id. Record it with: forge lane record --input '{"id":"${ask.issue}","request":"<request id>","scope":${JSON.stringify(ask.gated.input)}}'. Do not ask the owner yet.`,
        };
      if (message !== undefined && action === carrier)
        return {
          ...quiet(action),
          step: "owner",
          kind: "ask-owner",
          n: seq,
          why: `${ready.length} lane${ready.length === 1 ? "" : "s"} need the owner`,
          expect: `Send this text as your reply in this chat. When the owner answers, record it verbatim with: forge lane record --input '{"reply":"<their words, including #${seq}>","source":{"harness":"${owner.channel.harness}","thread":"${owner.channel.thread}","message":"<message id>"}}'`,
          ask: message,
        };
      return {
        ...quiet(action),
        kind: "wait",
        why:
          message !== undefined && ask.batch === seq
            ? `${action.why}. This lane is asked in the owner message sent in this call.`
            : `${action.why}. Queued for the owner; the next message is due ${next}.`,
        expect:
          "the owner's reply; Forge guesses nothing and the lane stays paused",
      };
    });
  } catch (error) {
    if (error instanceof StateProblem) return actions;
    throw error;
  }
}
/** A lane with an answered ask hands its chosen option to the driver before anything else. */
async function laneStep(
  call: HandlerCall<NextInput>,
  id: string,
): Promise<TailAction> {
  const state = client(call.services),
    shown = idsFor(state, call.config).shown(id);
  let row: AskRow | undefined;
  try {
    row = readAsk(state, id);
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    return guardPause(
      shown,
      error.message,
      "Forge cannot trust this stored ask, so the lane stays paused. Repair or remove the record, then run lane next again.",
      error.message,
    );
  }
  const ask = row?.value;
  if (ask?.status !== "answered" || ask.answer === undefined)
    return await guardedNext(call, id);
  // A stored answer never outranks the kill switch. Autopilot off returns only the guard's pause.
  // A stop flag lets through one thing: the owner-approved resume of exactly this lane's stop.
  try {
    const flags = readGlobal(state).value;
    const scope = flags.stopAll !== undefined ? { all: true } : { id: shown };
    const resumes =
      ask.answer.approval !== undefined &&
      ask.gated?.op === "lane.resume" &&
      canonical(ask.gated.input) === canonical(scope);
    if (
      !limitsOf(call.config).enabled ||
      ((flags.stopAll !== undefined || flags.stopped[id] !== undefined) &&
        !resumes)
    )
      return await guardedNext(call, id);
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    return await guardedNext(call, id);
  }
  const chosen = ask.options.find(
    (option) => option.label === ask.answer!.label,
  );
  return {
    lane: shown,
    step: "owner",
    n: ask.n ?? 0,
    kind: "harness",
    why: `The owner chose ${ask.answer.label}${chosen ? ` (${chosen.text})` : ""} on "${clip(ask.reason, 120)}". Their words: ${JSON.stringify(clip(ask.answer.quote, 300))}.`,
    expect: `Do what they chose${ask.answer.approval ? ", passing the approval to the gated operation" : ""}, then record it with: forge lane record --input '{"id":"${shown}","action":${ask.n ?? 0},"result":"{\\"done\\":true}"}'`,
    budget: { actions: 0, records: 0 },
    ...(ask.answer.approval ? { approval: ask.answer.approval } : {}),
  };
}
/**
 * Names the session whose replies count. The runtime has already required the owner's relayed
 * approval for this exact input; a bare handler call never reaches here from the CLI without it.
 */
function setOwnerChannel(call: HandlerCall<TailRecordInput>): {
  lane: string;
  step: string;
  n: number;
  recorded: true;
} {
  const { input, services } = call;
  const state = client(services);
  const channel = input.ownerChannel;
  if (!isChannel(channel))
    return fail("INPUT_INVALID", "ownerChannel needs a harness and a thread");
  let global: ReturnType<typeof readGlobal>;
  try {
    global = readGlobal(state);
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    return fail("INPUT_INVALID", `${error.message}; repair or remove it first`);
  }
  const owner = global.value.owner;
  // A different channel starts clean: an old message and reply window never carry over.
  if (owner === undefined || !sameChannel(owner.channel, channel)) {
    const seq = owner?.seq ?? owner?.batch?.seq;
    global.value.owner = {
      channel: { harness: channel.harness, thread: channel.thread },
      ...(seq === undefined ? {} : { seq }),
    };
    persist(state, GLOBAL, global.value, global.revision);
  }
  return { lane: "owner", step: "owner", n: 0, recorded: true };
}
/** Records the owner's reply verbatim and maps it; a reply that does not map keeps every lane paused. */
function ownerReply(call: HandlerCall<TailRecordInput>): ReplyResult {
  const { input, services } = call;
  const state = client(services);
  const { reply, source } = input;
  if (
    !nonEmpty(reply) ||
    reply.length > 2000 ||
    !isMap(source) ||
    !nonEmpty(source.harness) ||
    !nonEmpty(source.thread) ||
    (source.message !== undefined && !nonEmpty(source.message))
  )
    return fail(
      "INPUT_INVALID",
      "A reply needs the owner's words (at most 2000 characters) and a source with harness, thread and message",
    );
  let global: ReturnType<typeof readGlobal>;
  try {
    global = readGlobal(state);
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    return fail("INPUT_INVALID", `${error.message}; repair or remove it first`);
  }
  const owner = global.value.owner;
  if (owner?.batch === undefined || owner.batch.replied === true)
    return fail("INPUT_CONFLICT", "No owner message is waiting for a reply");
  if (!sameChannel(owner.channel, source))
    return fail(
      "INPUT_CONFLICT",
      `The reply is not from the owner channel (${owner.channel.harness}, ${owner.channel.thread}); nothing was recorded`,
    );
  const quote = reply.trim();
  const numbered = messageNumber(quote, source);
  if (numbered === undefined)
    return fail(
      "INPUT_INVALID",
      `Name the message this answers with its number, like "#${owner.batch.seq} 1A 2B"; nothing was recorded and every lane stays paused`,
    );
  if (numbered !== owner.batch.seq)
    return fail(
      "INPUT_CONFLICT",
      `This reply answers message #${numbered} but the latest is #${owner.batch.seq}; nothing was recorded, every lane stays paused and the owner is asked again`,
    );
  const at = new Date(state.now()).toISOString();
  const batch = owner.batch;
  const rows = batch.items.map((id): AskRow => {
    try {
      const row = readAsk(state, id);
      if (row) return row;
    } catch (error) {
      if (!(error instanceof StateProblem)) throw error;
      return fail("INPUT_CONFLICT", error.message);
    }
    return fail("INPUT_CONFLICT", `${ASK(id)} is missing`);
  });
  const mapped = mapReply(
    quote.replace(LEADING_NUMBER, " "),
    rows.map((row) => row.value),
  );
  // A resume bound to {all:true} clears every stop, so it needs every ask bound to that same
  // request to choose resume. Any hold or missing ask means nothing is approved and nothing moves.
  const resumesAll = (ask: Ask, label: string | undefined): boolean =>
    ask.gated?.input.all === true &&
    ask.options.find((option) => option.label === label)?.approve === true;
  const approving = new Set<string>();
  rows.forEach((row, index) => {
    const ask = row.value;
    if (
      mapped &&
      ask.status === "sent" &&
      ask.batch === batch.seq &&
      ask.gated?.request !== undefined &&
      resumesAll(ask, mapped[index])
    )
      approving.add(ask.gated.request);
  });
  const partial = [...approving].some((request) =>
    state.list("autopilot-ask:").some((other) => {
      const ask = other.value;
      if (!validAsk(ask) || !openAsk(ask) || ask.gated?.request !== request)
        return false;
      const at = rows.findIndex((row) => row.value.lane === ask.lane);
      return !(
        at >= 0 &&
        ask.status === "sent" &&
        ask.batch === batch.seq &&
        resumesAll(ask, mapped?.[at])
      );
    }),
  );
  const labels = partial ? undefined : mapped;
  const result: ReplyResult = {
    recorded: true,
    mapped: labels !== undefined,
    answers: [],
    approvals: [],
  };
  const heard = source;
  rows.forEach((row, index) => {
    const ask = row.value;
    emit(state, ask.lane, labels ? "reply" : "reply-unmapped", {
      quote,
      ...(labels ? { label: labels[index] } : {}),
      source: heard,
    });
    // Only an ask still waiting on this batch takes the answer; one that changed or resolved does not.
    if (!labels || ask.status !== "sent" || ask.batch !== batch.seq) return;
    const label = labels[index]!;
    const option = ask.options.find((entry) => entry.label === label)!;
    // A reply is an approval only for the gated step the ask carried, never a self-approval (D6).
    const approval: Approval | undefined =
      option.approve && ask.gated?.request !== undefined
        ? { request: ask.gated.request, quote, source: heard }
        : undefined;
    saveAsk(
      state,
      {
        ...ask,
        status: option.hold ? "held" : "answered",
        n: batch.seq,
        answer: {
          label,
          quote,
          source: heard,
          at,
          ...(approval ? { approval } : {}),
        },
      },
      row.revision,
    );
    result.answers.push({
      lane: ask.issue,
      label,
      choice: option.text,
      hold: option.hold === true,
    });
    // One resume-all approval, however many lanes share its request.
    if (
      approval &&
      ask.gated &&
      !result.approvals.some(
        (issued) => issued.approval.request === approval.request,
      )
    )
      result.approvals.push({
        lane: ask.issue,
        op: ask.gated.op,
        input: ask.gated.input,
        approval,
      });
  });
  if (labels) {
    batch.replied = true;
    delete owner.clarify;
    delete owner.allOrNothing;
  } else {
    owner.clarify = clip(quote, 2000);
    if (partial) owner.allOrNothing = true;
    else delete owner.allOrNothing;
  }
  persist(state, GLOBAL, global.value, global.revision);
  return result;
}
/** Closes the open owner decision once the driver has done what the owner chose. */
function ownerDecision(
  state: LeaseStateClient,
  id: string,
  action: number,
  result: string,
): { lane: string; step: string; n: number; recorded: true } | undefined {
  let row: AskRow | undefined;
  try {
    row = readAsk(state, id);
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    return fail("INPUT_CONFLICT", error.message);
  }
  if (row?.value.status !== "answered" || row.value.n !== action)
    return undefined;
  let done: unknown;
  try {
    done = JSON.parse(result);
  } catch {
    return fail("INPUT_INVALID", "result must be JSON");
  }
  if (!isMap(done) || done.done !== true)
    return fail("INPUT_INVALID", 'an owner decision needs {"done":true}');
  saveAsk(state, { ...row.value, status: "done" }, row.revision);
  emit(state, id, "decision-done", { label: row.value.answer?.label });
  return { lane: row.value.issue, step: "owner", n: action, recorded: true };
}
/** Attaches a gated step's request id to every open ask waiting on that same operation. */
function ownerRequest(call: HandlerCall<TailRecordInput>): {
  lane: string;
  step: string;
  n: number;
  recorded: true;
} {
  const { input, services, config } = call;
  const state = client(services),
    ids = idsFor(state, config),
    id = ids.stored(input.id!);
  const { request, scope, replaces } = input;
  if (
    !nonEmpty(request) ||
    !/^[A-Za-z0-9-]{1,200}$/.test(request) ||
    !isMap(scope) ||
    (replaces !== undefined &&
      (!nonEmpty(replaces) || !/^[A-Za-z0-9-]{1,200}$/.test(replaces)))
  )
    return fail(
      "INPUT_INVALID",
      "Give the request id from APPROVAL_REQUIRED and the scope it was asked for",
    );
  let row: AskRow | undefined;
  try {
    row = readAsk(state, id);
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    return fail("INPUT_CONFLICT", error.message);
  }
  const gate = row?.value.gated;
  // A renewal also reaches an ask whose owner answer carries the dead request; a hold or a done ask never.
  const renewable = openAsk(row?.value) || row?.value.status === "answered";
  if (
    !row ||
    !gate ||
    !(replaces === undefined ? openAsk(row.value) : renewable)
  )
    return fail(
      "INPUT_CONFLICT",
      `${input.id} has no open gated ask waiting for a request id`,
    );
  // The runtime already checked that this request is pending and bound to this scope. The scope
  // must also be exactly what the ask waits on, or an approval for one step could ride on another.
  if (canonical(scope) !== canonical(gate.input))
    return fail(
      "INPUT_CONFLICT",
      `The request is for ${canonical(scope)} but ${input.id} waits on ${canonical(gate.input)}`,
    );
  if (gate.request === request)
    return fail(
      "INPUT_CONFLICT",
      "That request id is already recorded for this ask",
    );
  if (gate.request !== undefined && replaces === undefined)
    return fail(
      "INPUT_CONFLICT",
      "This ask already has a request id; it is not replaced",
    );
  if (replaces !== undefined && replaces !== gate.request)
    return fail(
      "INPUT_CONFLICT",
      gate.request === undefined
        ? "This ask has no request id to replace"
        : "replaces names a request this ask does not carry",
    );
  // The runtime already reported the replaced request as expired or used. Every ask on it is asked
  // again, bound to the new id; an answer given for the old id is dropped, never carried over.
  if (replaces !== undefined) {
    const at = new Date(state.now()).toISOString();
    for (const other of state.list("autopilot-ask:")) {
      const ask = other.value;
      if (
        !validAsk(ask) ||
        !(openAsk(ask) || ask.status === "answered") ||
        ask.gated?.request !== replaces ||
        ask.gated.op !== gate.op ||
        canonical(ask.gated.input) !== canonical(gate.input)
      )
        continue;
      const { answer: _answer, batch: _batch, n: _n, ...rest } = ask;
      persist(
        state,
        other.key,
        {
          ...rest,
          gated: { ...ask.gated, request },
          queuedAt: at,
          status: "queued",
        },
        other.revision,
      );
    }
    emit(state, id, "request-renewed", { replaces, request });
    return { lane: ids.shown(id), step: "owner", n: 0, recorded: true };
  }
  for (const other of state.list("autopilot-ask:")) {
    const ask = other.value;
    if (
      !validAsk(ask) ||
      !openAsk(ask) ||
      !ask.gated ||
      ask.gated.request !== undefined
    )
      continue;
    if (
      ask.gated.op !== gate.op ||
      canonical(ask.gated.input) !== canonical(gate.input)
    )
      continue;
    persist(
      state,
      other.key,
      { ...ask, gated: { ...ask.gated, request } },
      other.revision,
    );
  }
  return { lane: ids.shown(id), step: "owner", n: 0, recorded: true };
}
async function laneNext(
  call: HandlerCall<NextInput>,
): Promise<TailAction | { actions: TailAction[] }> {
  const { input, services, config } = call;
  const state = client(services),
    ids = idsFor(state, config);
  if (input.all === true) {
    if (input.id !== undefined || input.pr !== undefined || input.head)
      fail("INPUT_INVALID", "--all takes no id, pr or head");
    const actions: TailAction[] = [];
    for (const id of activeLanes(state, laneFiles(services))) {
      try {
        actions.push(await laneStep(call, id));
      } catch (error) {
        // One lane that cannot be read never hides the others, and never acts.
        actions.push(
          guardPause(
            ids.shown(id),
            "Forge could not decide this lane's next action",
            "Check this lane by hand and tell me what to do.",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    return { actions: ownerRoute(call, actions) };
  }
  if (input.id === undefined)
    return fail("INPUT_INVALID", "Give a lane id or --all");
  const [routed] = ownerRoute(call, [
    await laneStep(call, ids.stored(input.id)),
  ]);
  return routed!;
}
function laneStop(call: HandlerCall<StopInput>): {
  stopped: string;
  at: string;
} {
  const { input, services, config } = call;
  const state = client(services),
    ids = idsFor(state, config);
  if ((input.all === true) === (input.id !== undefined))
    fail("INPUT_INVALID", "Give exactly one of a lane id or --all");
  const at = new Date(state.now()).toISOString();
  let value: GlobalState;
  let revision: number;
  let scope = "all";
  try {
    ({ value, revision } = readGlobal(state));
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    // An unreadable record is replaced by a stop of every lane: the safe direction.
    persist(
      state,
      GLOBAL,
      { stopAll: at, stopped: {} },
      state.get(GLOBAL)?.revision ?? 0,
    );
    return { stopped: "all", at };
  }
  if (input.all === true) value.stopAll ??= at;
  else {
    const id = ids.stored(input.id!);
    get(state, id, input.id);
    scope = ids.shown(id);
    value.stopped[id] ??= at;
  }
  persist(state, GLOBAL, value, revision);
  return { stopped: scope, at };
}
function laneResume(call: HandlerCall<ResumeInput>): { resumed: string } {
  const { input, services, config } = call;
  const state = client(services),
    ids = idsFor(state, config);
  if ((input.all === true) === (input.id !== undefined))
    fail("INPUT_INVALID", "Give exactly one of a lane id or --all");
  let value: GlobalState;
  let revision: number;
  try {
    ({ value, revision } = readGlobal(state));
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    return fail("INPUT_INVALID", `${error.message}; repair or remove it first`);
  }
  let scope = "all";
  if (input.all === true) {
    delete value.stopAll;
    value.stopped = {};
  } else {
    const id = ids.stored(input.id!);
    if (value.stopAll !== undefined)
      fail("INPUT_CONFLICT", "All lanes are stopped; resume all of them");
    delete value.stopped[id];
    scope = ids.shown(id);
  }
  value.resumed = {
    at: new Date(state.now()).toISOString(),
    scope,
    ...(input.approval?.quote === undefined
      ? {}
      : { quote: input.approval.quote.slice(0, 2000) }),
  };
  persist(state, GLOBAL, value, revision);
  // A resume is a state change: a hold the owner chose for the old pause no longer applies.
  for (const row of state.list("autopilot-ask:")) {
    const ask = row.value;
    if (
      validAsk(ask) &&
      heldAsk(ask) &&
      (input.all === true || ask.lane === ids.stored(input.id!))
    )
      persist(state, row.key, { ...ask, status: "done" }, row.revision);
  }
  return { resumed: scope };
}
async function laneStatus(
  call: HandlerCall<Record<string, never>>,
): Promise<LaneStatus> {
  const { services, config } = call;
  const state = client(services),
    ids = idsFor(state, config),
    limits = limitsOf(config),
    lanes = laneRegistry(laneFiles(services)).lanes,
    listed = activeLanes(state, laneFiles(services));
  let flags: GlobalState;
  let holding: number;
  let rows: LaneRow[];
  try {
    flags = readGlobal(state).value;
    // Count slots the way lane start does, so the two never disagree on the cap.
    holding = lanes.filter((lane) => holdsSlot(state, lane)).length;
    rows = listed.map((id) => {
      const used = usageOf(state, ids, id, limits);
      const recorded = beforeMerge(state, id);
      return {
        id: ids.shown(id),
        step: used.journal?.step ?? recorded.step ?? "before merge",
        ...(used.journal || recorded.pr
          ? { pr: used.journal?.pr ?? recorded.pr! }
          : {}),
        stopped: flags.stopAll !== undefined || flags.stopped[id] !== undefined,
        calls: used.calls,
        activeHours: used.activeHours,
        rounds: used.rounds,
      };
    });
  } catch (error) {
    if (!(error instanceof StateProblem)) throw error;
    // Unreadable state holds every start; a bad global record also counts as stopped.
    return {
      enabled: limits.enabled,
      stopped: error.global,
      stoppedLanes: [],
      hold: `hold: ${error.message}`,
      lanes: [],
    };
  }
  let load: Load | undefined;
  try {
    load = await (
      services as { environment?: Partial<EnvironmentService> }
    ).environment?.load?.();
  } catch {
    load = undefined;
  }
  if (!validLoad(load)) load = undefined;
  const decision = startDecision(holding, limits, load);
  return {
    enabled: limits.enabled,
    stopped: flags.stopAll !== undefined,
    stoppedLanes: Object.keys(flags.stopped).map(ids.shown),
    ...(decision.start ? {} : { hold: `hold: ${decision.reason}` }),
    ...(load ? { load } : {}),
    lanes: rows,
  };
}
function laneRecord(call: HandlerCall<TailRecordInput>):
  | {
      lane: string;
      step: string;
      n: number;
      recorded: true;
    }
  | ReplyResult {
  const { input, services, config } = call;
  if (input.ownerChannel !== undefined) {
    if (
      Object.keys(input).some(
        (name) => !["ownerChannel", "approval"].includes(name),
      )
    )
      return fail(
        "INPUT_INVALID",
        "Give the owner channel on its own, with its approval",
      );
    return setOwnerChannel(call);
  }
  if (input.approval !== undefined)
    return fail("INPUT_INVALID", "An approval goes only with an owner channel");
  if (input.reply !== undefined || input.source !== undefined) {
    if (
      input.id !== undefined ||
      input.action !== undefined ||
      input.result !== undefined ||
      input.mergeGate !== undefined ||
      input.request !== undefined ||
      input.replaces !== undefined
    )
      return fail("INPUT_INVALID", "Give a reply and its source on their own");
    return ownerReply(call);
  }
  if (input.id === undefined)
    return fail("INPUT_INVALID", "Give a lane id, or a reply with its source");
  const state = client(services),
    ids = idsFor(state, config),
    id = ids.stored(input.id);
  get(state, id, input.id);
  if (input.replaces !== undefined && input.request === undefined)
    return fail("INPUT_INVALID", "replaces goes with a new request id");
  if (input.request !== undefined) {
    if (
      input.action !== undefined ||
      input.result !== undefined ||
      input.mergeGate !== undefined
    )
      return fail(
        "INPUT_INVALID",
        "Give a request id on its own, not with an action or verdict",
      );
    return ownerRequest(call);
  }
  const gate = input.mergeGate;
  if (gate !== undefined) {
    if (input.action !== undefined || input.result !== undefined)
      return fail(
        "INPUT_INVALID",
        "Give a merge-gate verdict or an action result, not both",
      );
    if (
      !isCommit(gate.head) ||
      (gate.verdict !== "MERGE" && gate.verdict !== "FIX") ||
      typeof gate.reviewer !== "string" ||
      !gate.reviewer.trim() ||
      gate.reviewer.length > 200
    )
      return fail(
        "INPUT_INVALID",
        'merge-gate needs {"head":"<full sha>","verdict":"MERGE"|"FIX","reviewer":"<who>"}',
      );
    const verdict: MergeVerdict = {
      head: gate.head.toLowerCase(),
      verdict: gate.verdict,
      reviewer: gate.reviewer.trim(),
      at: new Date(state.now()).toISOString(),
    };
    // Only the newest verdict is kept; one for another head never counts for this one.
    persist(
      state,
      MERGE_KEY(id),
      verdict,
      state.get(MERGE_KEY(id))?.revision ?? 0,
    );
    emit(state, id, "merge-gate", verdict);
    return { lane: ids.shown(id), step: "merge", n: 0, recorded: true };
  }
  if (input.action === undefined || input.result === undefined)
    return fail("INPUT_INVALID", "Give action and result, or mergeGate");
  const action = input.action,
    resultText = input.result;
  const decision = ownerDecision(state, id, action, resultText);
  if (decision) return decision;
  const record = state.get(journalKey(id));
  const saved = record?.value as Journal | undefined;
  if (!record || !saved)
    return fail(
      "NOT_FOUND",
      `No autopilot journal for ${input.id}; run lane next first`,
    );
  if (saved.step === "done")
    return fail(
      "INPUT_CONFLICT",
      "The tail is done; there is nothing to record",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return fail("INPUT_INVALID", "result must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return fail("INPUT_INVALID", "result must be a JSON object");
  const result = parsed as Record<string, unknown>;
  const journal = JSON.parse(JSON.stringify(saved)) as Journal;
  journal.counters.records += 1;
  const open = saved.action;
  // A correction to a named target applies even when no action is open yet.
  if ("drop" in result || "replace" in result) {
    if (typeof result.reason !== "string" || !result.reason.trim())
      return fail("INPUT_INVALID", "A correction needs a nonempty reason");
    const swap = "replace" in result;
    const named = (value: unknown, label: string): string => {
      if (typeof value !== "string" || !value.trim())
        return fail("INPUT_INVALID", `${label} must be an issue id string`);
      return ids.stored(value);
    };
    if (swap === "drop" in result)
      return fail("INPUT_INVALID", "Give exactly one of drop or replace");
    const replace = result.replace as { from?: unknown; to?: unknown };
    if (swap && (typeof replace !== "object" || replace === null))
      return fail("INPUT_INVALID", "replace must be {from, to}");
    const from = named(
      swap ? replace.from : result.drop,
      swap ? "from" : "drop",
    );
    if (!journal.named.includes(from))
      return fail(
        "INPUT_INVALID",
        `${ids.shown(from)} is not a named closing target for ${input.id}`,
      );
    const to = swap ? named(replace.to, "to") : undefined;
    journal.named = journal.named.filter((name) => name !== from);
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
      n: action,
      recorded: true,
    };
  }
  if (!open || open.n !== action)
    return fail(
      "INPUT_CONFLICT",
      `Action ${action} is not the open action (${open ? `${open.n}, step ${open.step}` : "none"}); run lane next again`,
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
    const argv = (config as WorkConfig | undefined)?.lanes?.autopilot?.rebuild
      ?.argv;
    journal.recorded.rebuild = {
      exitCode: result.exitCode,
      ...(argv ? { argv: [...argv] } : {}),
    };
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
    result: resultText.slice(0, 2000),
  });
  return { lane: ids.shown(id), step: open.step, n: open.n, recorded: true };
}
const operations: Operations<WorkOperations> = {
  "lane.next": (call) => laneNext(call),
  "lane.stop": (call) => laneStop(call),
  "lane.resume": (call) => laneResume(call),
  "lane.status": (call) => laneStatus(call),
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
    const clock = laneClock(services);
    const run = async (args: string[], optional = false): Promise<string> => {
      const remaining = deadline - clock();
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
    const remoteHead = await laneMainBranch(config, () =>
      run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], true),
    );
    await sweepPrivateRefs(executor, git, files.root, env, clock());
    const baseRef = privateRefName(
      "lane-base",
      bound.crypto.randomUUID(),
      clock(),
    );
    let base: string;
    try {
      await run([
        "fetch",
        "origin",
        "+refs/heads/" + remoteHead + ":" + baseRef,
        ...PRIVATE_FETCH_FLAGS,
      ]);
      base = await run(["rev-parse", "--verify", baseRef + "^{commit}"]);
    } finally {
      await dropPrivateRefs(executor, git, files.root, env, [baseRef]);
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
      if (
        lanes.filter((lane) => holdsSlot(state, lane)).length >=
        (laneConfig?.max ?? 3)
      )
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
    const clock = laneClock(services);
    const run = async (
      args: string[],
      cwd = checkout,
      github = false,
      optional = false,
      leaveDirectory?: string,
    ) => {
      const remaining = deadline - clock();
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
      const recorded = lane?.branch ?? progress?.branch,
        worktree = lane?.worktree ?? progress?.worktree;
      if (typeof recorded !== "string" || typeof worktree !== "string")
        fail("NOT_FOUND", `No recorded lane for ${current.id}`);
      let branch: string = recorded;
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
                "state,headRefName,baseRefName,headRefOid,mergeCommit,url",
              ],
              checkout,
              true,
            ),
          ) as {
            state?: string;
            headRefName?: string;
            baseRefName?: string;
            headRefOid?: string;
            mergeCommit?: { oid?: string } | null;
            url?: string;
          });
      const commit = (value: unknown): value is string =>
        typeof value === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
      // A lane that moved to a new branch delivers its PR from that branch. The
      // checkout (or the pinned close journal on resume) must be on that branch.
      if (
        !noPr &&
        typeof pull.headRefName === "string" &&
        pull.headRefName !== recorded
      ) {
        const switched =
          progress?.branch === pull.headRefName
            ? pull.headRefName
            : await run(
                ["-C", worktree, "symbolic-ref", "--short", "HEAD"],
                checkout,
                false,
                true,
              );
        if (switched === pull.headRefName) branch = switched;
      }
      if (progress && progress.branch !== branch)
        refuse("INPUT_CONFLICT", "Resume the pending close arguments");
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
      if (!dropped) {
        // A merge into another branch has not landed. Check before any write.
        const main = await laneMainBranch(config, () =>
          run(
            ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
            checkout,
            false,
            true,
          ),
        );
        if (pull.baseRefName !== main)
          refuse("PR_NOT_MERGED", `PR must be merged into ${main}`);
        // Fetch main into a ref only this call uses: FETCH_HEAD is shared, and
        // any other fetch in the repository can overwrite it.
        const mainRef = privateRefName(
          "lane-close",
          bound.crypto?.randomUUID() ??
            fail("UNAVAILABLE", "Lane close requires crypto"),
          clock(),
        );
        await sweepPrivateRefs(executor, git, checkout, env, clock());
        try {
          await run([
            "fetch",
            "origin",
            `+refs/heads/${main}:${mainRef}`,
            ...PRIVATE_FETCH_FLAGS,
          ]);
          const common = await run(
            ["merge-base", mergeCommit, mainRef],
            checkout,
            false,
            true,
          );
          if (common.toLowerCase() !== mergeCommit.toLowerCase()) {
            // A shallow clone may simply lack the history that proves it.
            if (
              (await run(
                ["rev-parse", "--is-shallow-repository"],
                checkout,
                false,
                true,
              )) === "true"
            )
              refuse(
                "MERGE_UNVERIFIABLE",
                `This clone has shallow history, so the merge commit cannot be checked against ${main}. Run git fetch --unshallow origin and retry`,
              );
            refuse("PR_NOT_MERGED", `Merge commit is not on ${main}`);
          }
        } finally {
          // Best effort: a leftover private ref is harmless and must not mask
          // the check result. The next lane command sweeps it.
          await dropPrivateRefs(executor, git, checkout, env, [mainRef]);
        }
      }
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
