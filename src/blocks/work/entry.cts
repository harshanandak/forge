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
type WorkOperations = TrackerOperations<"issue"> & {
  readonly "issue.ready": readonly [
    ListItemsInput,
    { items: readonly TrackerItem[] },
  ];
  readonly "issue.blocked": readonly [
    ListItemsInput,
    { items: readonly TrackerItem[] },
  ];
  readonly "issue.stale": readonly [
    ListItemsInput,
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
function get(state: LeaseStateClient, id: string): StateRecord {
  const record = state.get(key(id));
  if (!record) fail("NOT_FOUND", `Issue ${id} was not found`);
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
function item(state: LeaseStateClient, record: StateRecord): TrackerItem {
  const { closeReason: _reason, ...value } = stored(record) as Stored & {
    closeReason?: string;
  };
  const lease = live(state, value.id);
  return {
    ...value,
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
function validateDependencies(
  state: LeaseStateClient,
  id: string,
  dependencies: readonly string[],
): readonly { readonly key: string; readonly expectRevision: number }[] {
  const readSet: { key: string; expectRevision: number }[] = [];
  const walk = (dependency: string, path: Set<string>): void => {
    if (dependency === id || path.has(dependency))
      fail("INPUT_CONFLICT", "Dependencies must not contain a cycle");
    const record = get(state, dependency);
    readSet.push({ key: record.key, expectRevision: record.revision });
    const value = stored(record);
    for (const next of value.dependsOn)
      walk(next, new Set([...path, dependency]));
  };
  for (const dependency of dependencies) walk(dependency, new Set());
  return readSet;
}
function blocked(state: LeaseStateClient, value: Stored): boolean {
  return value.dependsOn.some((id) => {
    const dependency = state.get(key(id));
    return !dependency || stored(dependency).status !== "closed";
  });
}
function list(
  state: LeaseStateClient,
  input: ListItemsInput,
  mode?: "ready" | "blocked" | "stale",
): { items: readonly TrackerItem[] } {
  let records = state.list("issue:");
  if (input.status)
    records = records.filter(
      (record) => stored(record).status === input.status,
    );
  if (mode || input.ready)
    records = records.filter((record) => {
      const value = stored(record);
      if (value.status !== "open") return false;
      if (mode === "blocked") return blocked(state, value);
      if (mode === "stale") {
        const lease = state.lease(key(value.id));
        return (
          lease !== undefined &&
          lease.releasedAt === undefined &&
          Date.parse(lease.expiresAt) <= state.now()
        );
      }
      return !blocked(state, value) && !live(state, value.id);
    });
  return {
    items: records
      .slice(0, input.limit ?? 1000)
      .map((record) => item(state, record)),
  };
}
function update(state: LeaseStateClient, input: UpdateItemInput): TrackerItem {
  const record = get(state, input.id);
  const value = stored(record);
  const readSet = input.dependsOn
    ? validateDependencies(state, input.id, input.dependsOn)
    : undefined;
  const { id: _id, expectRevision, ...patch } = input;
  return item(
    state,
    persist(
      state,
      key(input.id),
      { ...value, ...patch },
      expectRevision,
      undefined,
      readSet,
    ),
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
): LeaseGrant {
  const read = state.lease(key(id));
  // A replay returns the original expiry even if a later renewal extended the current lease.
  if (
    !read ||
    read.generation !== lease.generation ||
    canonical(read.holder) !== canonical(lease.holder)
  )
    fail("INTERNAL", "Accepted lease did not match its readback");
  return { id, generation: lease.generation, expiresAt: lease.expiresAt };
}
const operations: Operations<WorkOperations> = {
  "issue.create": ({ input, services }) => {
    const state = client(services);
    checkKind(input.kind);
    const records = state.list("issue:");
    const sequence =
      records.reduce(
        (max, record) =>
          Math.max(max, Number(stored(record).id.replace(/^work-/, "")) || 0),
        0,
      ) + 1;
    const id = `work-${sequence}`;
    const readSet = validateDependencies(state, id, input.dependsOn ?? []);
    if (input.parent) get(state, input.parent);
    const value: Stored = {
      id,
      title: input.title,
      status: "open",
      labels: input.labels ?? [],
      dependsOn: input.dependsOn ?? [],
      createdAt: new Date(state.now()).toISOString(),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.parent === undefined ? {} : { parent: input.parent }),
    };
    return item(state, persist(state, key(id), value, 0, undefined, readSet));
  },
  "issue.show": ({ input, services }) => {
    const state = client(services);
    return item(state, get(state, input.id));
  },
  "issue.list": ({ input, services }) => list(client(services), input),
  "issue.ready": ({ input, services }) =>
    list(client(services), input, "ready"),
  "issue.blocked": ({ input, services }) =>
    list(client(services), input, "blocked"),
  "issue.stale": ({ input, services }) =>
    list(client(services), input, "stale"),
  "issue.update": ({ input, services }) => update(client(services), input),
  "issue.claim": ({ input, services }) => {
    const state = client(services);
    if (stored(get(state, input.id)).status !== "open")
      fail("INPUT_CONFLICT", "Closed issues cannot be claimed");
    const acquired = state.acquire(
      key(input.id),
      (input.ttlSeconds ?? 3600) * 1000,
    );
    // Another holder may close between the initial read and acquisition.
    if (stored(get(state, input.id)).status !== "open") {
      state.release(key(input.id));
      fail(
        "INPUT_CONFLICT",
        "The issue closed during acquisition; the grant was revoked",
      );
    }
    return grant(state, input.id, acquired);
  },
  "issue.renew": ({ input, services }) => {
    const state = client(services);
    get(state, input.id);
    return grant(
      state,
      input.id,
      state.renew(key(input.id), (input.ttlSeconds ?? 3600) * 1000),
    );
  },
  "issue.release": ({ input, services }) => {
    const state = client(services);
    get(state, input.id);
    const released = state.release(key(input.id));
    if (canonical(state.lease(key(input.id))) !== canonical(released))
      fail("INTERNAL", "Released lease did not match its readback");
    return { id: input.id };
  },
  "issue.close": ({ input, services }) => {
    const state = client(services);
    const record = get(state, input.id);
    // The reason and status share one accepted record; there is no second close write.
    const value = {
      ...stored(record),
      status: "closed",
      ...(input.reason === undefined ? {} : { closeReason: input.reason }),
    };
    const written = persist(state, key(input.id), value, record.revision);
    const { closeReason: _reason, ...view } = written.value as Stored & {
      closeReason?: string;
    };
    return item(state, { ...written, value: view });
  },
  "issue.comment": ({ input, services }) => {
    const state = client(services);
    get(state, input.id);
    const prefix = `comment:${input.id}:`;
    const commentId = `${prefix}${state.list(prefix).length + 1}`;
    persist(state, commentId, { id: input.id, body: input.body }, 0);
    return { id: input.id, commentId };
  },
  "issue.comments": ({ input, services }) => {
    const state = client(services);
    get(state, input.id);
    return { records: appended(state, `comment:${input.id}:`) };
  },
  "issue.events": ({ input, services }) => {
    const state = client(services);
    get(state, input.id);
    return { events: state.events(key(input.id)) };
  },
  "issue.dep": ({ input, services }) => {
    const state = client(services);
    const value = stored(get(state, input.id));
    const dependsOn =
      input.action === "add"
        ? [...new Set([...value.dependsOn, input.target])]
        : value.dependsOn.filter((id) => id !== input.target);
    if (dependsOn.length > 256)
      fail("INPUT_INVALID", "At most 256 dependencies are allowed");
    return update(state, {
      id: input.id,
      expectRevision: input.expectRevision,
      dependsOn,
    });
  },
  "issue.link": ({ input, services }) => {
    const state = client(services);
    get(state, input.id);
    if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(input.url))
      fail("INPUT_INVALID", "Links require an http or https URL");
    const prefix = `link:${input.id}:`;
    return persist(
      state,
      `${prefix}${state.list(prefix).length + 1}`,
      input,
      0,
      key(input.id),
    );
  },
  "issue.links": ({ input, services }) => {
    const state = client(services);
    get(state, input.id);
    return { records: appended(state, `link:${input.id}:`) };
  },
  "issue.lint": ({ services }) => {
    const state = client(services);
    const problems: string[] = [];
    for (const record of state.list("issue:")) {
      const value = stored(record);
      if (value.kind !== undefined && !kinds.includes(value.kind))
        problems.push(`${value.id}: unknown kind`);
      try {
        validateDependencies(state, value.id, value.dependsOn);
      } catch {
        problems.push(`${value.id}: missing or cyclic dependency`);
      }
      if (value.parent !== undefined && !state.get(key(value.parent)))
        problems.push(`${value.id}: missing parent`);
    }
    return { problems };
  },
};
module.exports = operations;
