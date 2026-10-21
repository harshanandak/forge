import type { Operations, TrackerOperations } from "../../contract/author.ts";
import type { LeaseStateClient } from "../../assembly/state-client.ts";
import type {
  StateRecord,
  TrackerItem,
  UpdateItemInput,
  ListItemsInput,
  ItemRef,
  LeaseGrant,
  StateEvent,
} from "../../generated/types.ts";

declare const fail: (code: string, message: string) => never;
type Stored = Omit<TrackerItem, "lease" | "revision" | "updatedAt">;
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
type WorkListInput = ListItemsInput & { readonly labels?: readonly string[] };
type WorkConfig = {
  readonly labelOrder?: readonly string[];
  readonly idPrefix?: string;
};
type WorkOperations = TrackerOperations<"issue"> & {
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
  readonly "issue.lint": readonly [
    ListItemsInput,
    { problems: readonly string[] },
  ];
};
const kinds: readonly string[] = ["task", "bug", "feature", "epic"];
/**
 * Items are stored as `work-<n>`, the form they have always had, and shown as `<idPrefix>-<n>`.
 * The number is the identity, so changing the prefix rewrites nothing. An id resolves only with
 * the current prefix or one this project has minted ids with, so another project's id is refused
 * instead of naming an unrelated item here. An id of another shape is used as given.
 */
const STORED = "work-";
const QUALIFIED = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/i;
const USED = "prefix:";
type Ids = {
  readonly prefix: string;
  readonly stored: (id: string) => string;
  readonly shown: (id: string) => string;
};
/** The current prefix and every one ids were minted with; a store from before they were recorded minted `work`. */
function accepted(state: LeaseStateClient, prefix: string): readonly string[] {
  const used = state.list(USED).map((record) => record.key.slice(USED.length));
  if (!used.length && state.list("issue:").length) used.push("work");
  return [...new Set([prefix, ...used])];
}
function idsFor(state: LeaseStateClient, config: unknown): Ids {
  const prefix = (config as WorkConfig | undefined)?.idPrefix ?? "work";
  let known: readonly string[] | undefined;
  return {
    prefix,
    stored(id) {
      const match = QUALIFIED.exec(id);
      if (!match) return id;
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
/** Records the prefix a new id is minted with (and `work` for a store from before prefixes were recorded). */
function remember(state: LeaseStateClient, prefix: string): void {
  for (const used of accepted(state, prefix))
    if (!state.get(`${USED}${used}`))
      persist(state, `${USED}${used}`, { prefix: used }, 0);
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
  const { closeReason: _reason, ...value } = stored(record) as Stored & {
    closeReason?: string;
  };
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
    const root = dependencies ?? stored(read(id)!).dependsOn;
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
        dependencies: stored(record).dependsOn,
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
): readonly { readonly key: string; readonly expectRevision: number }[] {
  const graph = dependencyGraph(state);
  if (!graph.check(id, dependencies)) {
    const [missing] = graph.missing;
    if (missing !== undefined)
      fail("NOT_FOUND", `Issue ${ids.shown(missing)} was not found`);
    fail("INPUT_CONFLICT", "Dependencies must not contain a cycle");
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
): { items: readonly TrackerItem[] } {
  let records = state.list("issue:");
  const graph = dependencyGraph(state, records);
  const wanted = input.labels;
  if (wanted?.length)
    records = records.filter((record) =>
      wanted.every((label) => stored(record).labels.includes(label)),
    );
  if (input.status)
    records = records.filter(
      (record) => stored(record).status === input.status,
    );
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
  const ids = idsFor(state, config);
  return {
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
  const readSet = input.dependsOn
    ? validateDependencies(state, input.id, input.dependsOn, ids)
    : undefined;
  const { id, expectRevision, ...patch } = input;
  return item(
    state,
    persist(
      state,
      key(id),
      { ...value, ...patch },
      expectRevision,
      undefined,
      readSet,
    ),
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
function grant(
  state: LeaseStateClient,
  id: string,
  lease: ReturnType<LeaseStateClient["acquire"]>,
  ids: Ids,
): LeaseGrant {
  const read = state.lease(key(id));
  // A replay returns the original expiry even if a later renewal extended the current lease.
  if (
    !read ||
    read.generation !== lease.generation ||
    canonical(read.holder) !== canonical(lease.holder)
  )
    fail("INTERNAL", "Accepted lease did not match its readback");
  return {
    id: ids.shown(id),
    generation: lease.generation,
    expiresAt: lease.expiresAt,
  };
}
const operations: Operations<WorkOperations> = {
  "issue.create": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    checkKind(input.kind);
    const dependsOn = (input.dependsOn ?? []).map(ids.stored);
    const parent =
      input.parent === undefined ? undefined : ids.stored(input.parent);
    if (parent !== undefined) get(state, parent, input.parent);
    remember(state, ids.prefix);
    const records = state.list("issue:");
    const sequence =
      records.reduce((max, record) => {
        const { id } = stored(record);
        return id.startsWith(STORED)
          ? Math.max(max, Number(id.slice(STORED.length)) || 0)
          : max;
      }, 0) + 1;
    const id = `${STORED}${sequence}`;
    const readSet = validateDependencies(state, id, dependsOn, ids);
    const value: Stored = {
      id,
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
    const acquired = state.acquire(key(id), (input.ttlSeconds ?? 3600) * 1000);
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
    return grant(
      state,
      id,
      state.renew(key(id), (input.ttlSeconds ?? 3600) * 1000),
      ids,
    );
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
  "issue.close": ({ input, services, config }) => {
    const state = client(services);
    const ids = idsFor(state, config);
    const id = ids.stored(input.id);
    const record = get(state, id, input.id);
    // The reason and status share one accepted record; there is no second close write.
    const value = {
      ...stored(record),
      status: "closed",
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
    const commentId = `${prefix}${state.list(prefix).length + 1}`;
    persist(state, commentId, { id, body: input.body }, 0);
    return { id: ids.shown(id), commentId };
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
      `${prefix}${state.list(prefix).length + 1}`,
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
      if (value.parent !== undefined && !graph.read(value.parent))
        problems.push(`${id}: missing parent`);
    }
    return { problems };
  },
};
module.exports = operations;
