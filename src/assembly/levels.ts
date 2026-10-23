import { basename, isAbsolute, join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { StateOwner } from "../core/state/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { Actor, BoundContext, Caller } from "../generated/types.ts";
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
 * The forge.project-state@1 capability: this host's project store and, read-only, other projects
 * on the device. A block gets it by declaring the slot. The project is the one the host was
 * assembled for, never one named in a request, so an operation's declared context alone decides
 * what it may read. The project store opens only when asked; other projects open read-only, by the
 * stable id or the name the device registered them under, and never by a path.
 */
export const PROJECT_STATE = "forge.project-state@1.0.0";
export interface StoreLevels {
  /** The caller the transport authenticated for this invocation; never a caller-supplied field. */
  readonly caller: Caller;
  /** True when this host serves a project. Nothing is opened to answer it. */
  readonly inProject: boolean;
  /**
   * The host's project store. A writing operation mints the project's identity on first use and
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
  return typeof name === "string" &&
    typeof root === "string" &&
    isAbsolute(root) &&
    !root.includes("\0")
    ? { name, root }
    : undefined;
}

/** The existing device registry survives a lost project store; config alone proves nothing. */
function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return root;
  }
}

/** Saved roots are canonical observations, never paths to resolve again. */
function wasRegisteredAt(
  device: StateOwner | undefined,
  root: string,
): boolean {
  root = canonicalRoot(root);
  let from = REGISTRY_PREFIX;
  while (device) {
    const page = device.listRange(REGISTRY_NAMESPACE, {
      from,
      to: REGISTRY_END,
      limit: REGISTRY_PAGE,
    });
    for (const record of page) {
      const entry = registered(record.value);
      if (entry && relative(entry.root, root) === "") return true;
    }
    if (page.length < REGISTRY_PAGE) break;
    from = `${page.at(-1)!.key}\0`;
  }
  return false;
}

export async function requireRegisteredStore(
  deviceState: LocalState,
  root: string,
): Promise<void> {
  const lease = await deviceState.acquire(false);
  try {
    if (wasRegisteredAt(lease.value, root))
      refuse(
        "UNAVAILABLE",
        `Missing Forge store at ${join(root, ".forge", "state.sqlite")}. Fix: restore it from a backup, or run forge store reinit to start a new empty store.`,
      );
  } finally {
    await lease.close();
  }
}

export function openLevels(options: {
  readonly root: string;
  /** The folder holding the project store; registered so every git worktree records one place. */
  readonly stateRoot: string;
  readonly projectState: LocalState;
  readonly deviceState: LocalState;
  readonly namespace: string;
  readonly actor: Actor;
  /** Whether the host serves a project: a host signal, never assumed. */
  readonly servesProject: boolean;
  /** The invocation's authenticated caller, from the runtime-validated request. */
  readonly caller: Caller;
  /** The operation declared its record write effect; its stores open writable. */
  readonly write: boolean;
  readonly requestId: string;
  /** Only the explicit recovery invocation replaces registrations for this root. */
  readonly replaceRegistration?: boolean;
}): { readonly levels: StoreLevels; close(): Promise<void> } {
  const { root, actor, namespace, requestId } = options;
  const handles: OwnedHandle<unknown>[] = [];
  const peers: LocalState[] = [];
  let own: Promise<ProjectStore | undefined> | undefined;
  let device: Promise<StateOwner | undefined> | undefined;
  /** The device store, opened once and only when a registration or a lookup needs it. */
  const deviceOwner = (): Promise<StateOwner | undefined> =>
    (device ??= options.deviceState.acquire(options.write).then((lease) => {
      handles.push(lease);
      return lease.value;
    }));
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
  async function register(id: string, name: string): Promise<void> {
    const device = await deviceOwner();
    if (!device)
      refuse("PROVIDER_MISSING", "The device store is not open for writing");
    const key = `${REGISTRY_PREFIX}${id}`;
    const current = device.get(REGISTRY_NAMESPACE, key);
    const known = registered(current?.value);
    const where = canonicalRoot(options.stateRoot);
    if (known?.name === name && relative(known.root, where) === "") return;
    device.put(REGISTRY_NAMESPACE, key, { name, root: where }, actor, {
      expectRevision: current?.revision ?? 0,
    });
    if (options.replaceRegistration) {
      let from = REGISTRY_PREFIX;
      for (;;) {
        const page = device.listRange(REGISTRY_NAMESPACE, {
          from,
          to: REGISTRY_END,
          limit: REGISTRY_PAGE,
        });
        for (const record of page) {
          const entry = registered(record.value);
          if (record.key !== key && entry && relative(entry.root, where) === "")
            device.delete(REGISTRY_NAMESPACE, record.key, actor, {
              expectRevision: record.revision,
            });
        }
        if (page.length < REGISTRY_PAGE) break;
        from = `${page.at(-1)!.key}\0`;
      }
    }
  }
  async function openOwn(): Promise<ProjectStore | undefined> {
    const lease = await options.projectState.acquire(options.write);
    handles.push(lease);
    const owner = lease.value;
    const name = projectName(root);
    let id = identityOf(owner);
    if (options.write && owner) {
      id ??= mint(owner);
      await register(id, name);
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
  async function lookup(
    ref: string,
  ): Promise<
    | PeerLookup
    | { status: "registered"; identity: ProjectIdentity; root: string }
  > {
    const device = await deviceOwner();
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
    inProject: options.servesProject,
    project() {
      if (!options.servesProject) return Promise.resolve(undefined);
      own ??= openOwn();
      return own;
    },
    async peer(ref: string): Promise<PeerLookup> {
      const found = await lookup(ref);
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
