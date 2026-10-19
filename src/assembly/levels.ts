import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { StateOwner } from "../core/state/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type {
  Actor,
  BoundContext,
  Caller,
  InvocationRequest,
} from "../generated/types.ts";
import type { ExtendedStateClient } from "../ports/state.ts";
import type { OwnedHandle } from "../ports/lifetime.ts";
import { refuse } from "../core/trust/index.ts";
import { createStateClient } from "./state-client.ts";
import { LocalState } from "./state.ts";

/** The project's own identity record, in its project store. */
const IDENTITY_NAMESPACE = "forge/core-project";
const IDENTITY_KEY = "identity";
/** The device's list of projects it has written for, in the device store. */
const REGISTRY_NAMESPACE = "forge/core-projects";
const REGISTRY_PREFIX = "project/";
const REGISTRY_END = "project/\u{10FFFF}";
/** Safety ceilings, not policy: a name lookup reads one page; one call opens few other stores. */
const REGISTRY_PAGE = 1000;
const MAX_PEERS = 8;
const PROJECT_ID = /^[0-9a-f]{16}$/;

export interface ProjectIdentity {
  readonly id: string;
  readonly name: string;
}
export interface ProjectStore {
  readonly identity: ProjectIdentity;
  readonly state: ExtendedStateClient;
}
export type PeerLookup =
  | {
      readonly status: "found";
      readonly identity: ProjectIdentity;
      readonly state: ExtendedStateClient;
    }
  | { readonly status: "not_found"; readonly ref: string }
  | { readonly status: "unavailable"; readonly identity: ProjectIdentity }
  | {
      readonly status: "ambiguous";
      readonly ref: string;
      readonly candidates: readonly ProjectIdentity[];
    };

/**
 * What a device-context state client may reach besides the device store. The caller's project
 * opens only when asked; other projects open read-only, by the stable id or the name the device
 * registered them under, and never by a path.
 */
export interface StoreLevels {
  readonly caller: Caller;
  /** True when the request names this assembly's project. Nothing is opened to answer it. */
  readonly inProject: boolean;
  /**
   * The caller's project store. A writing operation mints the project's identity on first use and
   * records the project on the device; a reading one never creates a store and gets undefined when
   * the project has no identity yet.
   */
  project(): Promise<ProjectStore | undefined>;
  /** Another project on this device, read-only. */
  peer(ref: string): Promise<PeerLookup>;
}

function conflict(error: unknown): boolean {
  return (
    error instanceof ForgeFailure && error.error.code === "REVISION_CONFLICT"
  );
}
/** Folder names become labels: plain characters only, so a label can never carry markup. */
export function projectName(root: string): string {
  return (
    basename(root)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 64) || "project"
  );
}
function identityOf(owner: StateOwner | undefined): string | undefined {
  const value = owner?.get(IDENTITY_NAMESPACE, IDENTITY_KEY)?.value as
    { id?: unknown } | undefined;
  return typeof value?.id === "string" && PROJECT_ID.test(value.id)
    ? value.id
    : undefined;
}
function registered(
  value: unknown,
): { name: string; root: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, root } = value as { name?: unknown; root?: unknown };
  return typeof name === "string" && typeof root === "string"
    ? { name, root }
    : undefined;
}

export function openLevels(options: {
  readonly root: string;
  readonly projectState: LocalState;
  /** The device store this invocation already holds. */
  readonly device: StateOwner | undefined;
  readonly namespace: string;
  readonly actor: Actor;
  readonly caller: Caller;
  readonly inProject: boolean;
  /** The operation declared its record write effect. */
  readonly write: boolean;
  /** The operation declared any effect, so its stores open writable. */
  readonly writable: boolean;
  readonly requestId: string;
}): { readonly levels: StoreLevels; close(): Promise<void> } {
  const { root, actor, namespace, requestId } = options;
  const handles: OwnedHandle<unknown>[] = [];
  const peers: LocalState[] = [];
  let own: Promise<ProjectStore | undefined> | undefined;
  const context = (projectRoot: string): BoundContext => ({
    variant: "project",
    actor,
    project: { id: projectRoot, root: projectRoot },
  });

  function mint(owner: StateOwner): string {
    for (;;) {
      const existing = identityOf(owner);
      if (existing) return existing;
      try {
        owner.put(
          IDENTITY_NAMESPACE,
          IDENTITY_KEY,
          { id: randomBytes(8).toString("hex") },
          actor,
          {
            expectRevision:
              owner.get(IDENTITY_NAMESPACE, IDENTITY_KEY)?.revision ?? 0,
          },
        );
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
  }
  /** Record where the project lives, skipping the write when nothing changed. */
  function register(id: string, name: string): void {
    const device = options.device;
    if (!device)
      refuse("PROVIDER_MISSING", "The device store is not open for writing");
    const key = `${REGISTRY_PREFIX}${id}`;
    const current = device.get(REGISTRY_NAMESPACE, key);
    const known = registered(current?.value);
    if (known?.name === name && known.root === root) return;
    device.put(REGISTRY_NAMESPACE, key, { name, root }, actor, {
      expectRevision: current?.revision ?? 0,
    });
  }
  async function openOwn(): Promise<ProjectStore | undefined> {
    const lease = await options.projectState.acquire(options.writable);
    handles.push(lease);
    const owner = lease.value;
    const name = projectName(root);
    let id = identityOf(owner);
    if (options.writable && owner) {
      id = mint(owner);
      register(id, name);
    }
    if (!id) return undefined;
    return {
      identity: { id, name },
      state: createStateClient({
        owner,
        namespace,
        context: context(root),
        write: options.write,
        requestId,
      }),
    };
  }
  function lookup(
    ref: string,
  ):
    | PeerLookup
    | { status: "registered"; identity: ProjectIdentity; root: string } {
    const device = options.device;
    if (PROJECT_ID.test(ref)) {
      const entry = registered(
        device?.get(REGISTRY_NAMESPACE, `${REGISTRY_PREFIX}${ref}`)?.value,
      );
      return entry
        ? {
            status: "registered",
            identity: { id: ref, name: entry.name },
            root: entry.root,
          }
        : { status: "not_found", ref };
    }
    const matches = (
      device?.listRange(REGISTRY_NAMESPACE, {
        from: REGISTRY_PREFIX,
        to: REGISTRY_END,
        limit: REGISTRY_PAGE,
      }) ?? []
    )
      .map((record) => ({
        id: record.key.slice(REGISTRY_PREFIX.length),
        entry: registered(record.value),
      }))
      .filter((match) => match.entry?.name === ref);
    if (matches.length === 0) return { status: "not_found", ref };
    if (matches.length > 1)
      return {
        status: "ambiguous",
        ref,
        candidates: matches.map((match) => ({ id: match.id, name: ref })),
      };
    const [match] = matches;
    return {
      status: "registered",
      identity: { id: match!.id, name: ref },
      root: match!.entry!.root,
    };
  }

  const levels: StoreLevels = {
    caller: options.caller,
    inProject: options.inProject,
    project() {
      if (!options.inProject) return Promise.resolve(undefined);
      own ??= openOwn();
      return own;
    },
    async peer(ref: string): Promise<PeerLookup> {
      const found = lookup(ref);
      if (found.status !== "registered") return found;
      if (peers.length >= MAX_PEERS)
        refuse(
          "LIMIT_EXCEEDED",
          `One call reads at most ${MAX_PEERS} other projects`,
        );
      const state = new LocalState(join(found.root, ".forge", "state.sqlite"));
      peers.push(state);
      const lease = await state.acquire(false);
      handles.push(lease);
      // A folder that moved, or now holds a different project, is not the one the caller named.
      if (identityOf(lease.value) !== found.identity.id)
        return { status: "unavailable", identity: found.identity };
      return {
        status: "found",
        identity: found.identity,
        state: createStateClient({
          owner: lease.value,
          namespace,
          context: context(found.root),
          write: false,
          requestId,
        }),
      };
    },
  };
  return {
    levels,
    async close() {
      const closed = await Promise.allSettled([
        ...handles.map((handle) => handle.close()),
      ]);
      const stores = await Promise.allSettled(
        peers.map((state) => state.close()),
      );
      const errors = [...closed, ...stores].flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Level stores failed to close");
    },
  };
}

/**
 * Give a device-context state client its levels. The handle that closes the stores it opens joins
 * the invocation's leases, so they close when the invocation settles.
 */
export function attachLevels<Client extends object>(
  client: Client,
  options: {
    readonly root: string;
    readonly projectState: LocalState;
    readonly device: StateOwner | undefined;
    readonly namespace: string;
    readonly actor: Actor;
    readonly request: InvocationRequest;
    /** The operation declared its record write effect; its stores open writable. */
    readonly write: boolean;
    readonly leases: OwnedHandle<unknown>[];
  },
): Client & StoreLevels {
  const { request } = options;
  const named = request.context.project;
  if (named !== undefined && named.id !== options.root)
    refuse("INPUT_CONFLICT", "State context belongs to another project");
  const opened = openLevels({
    root: options.root,
    projectState: options.projectState,
    device: options.device,
    namespace: options.namespace,
    actor: options.actor,
    caller: request.caller,
    inProject: named !== undefined,
    write: options.write,
    writable: options.write,
    requestId: request.requestId,
  });
  options.leases.push({
    ownership: "owned",
    value: undefined,
    close: () => opened.close(),
  });
  return Object.freeze({ ...client, ...opened.levels });
}
