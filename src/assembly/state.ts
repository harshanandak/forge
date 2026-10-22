import { dirname } from "node:path";
import { closeSync, existsSync, fstatSync } from "node:fs";
import { StateOwner } from "../core/state/index.ts";
import { createSqliteStore } from "../adapters/store-sqlite/index.ts";
import { windowsPrivateFiles } from "../adapters/process/windows-acl.ts";
import {
  privateFileGuard,
  type PrivateFileGuard,
} from "../adapters/store-sqlite/private-files.ts";
import {
  ensurePrivateDirectory,
  createPrivateFile,
  securedFileOps,
  removeOwnedFile,
  type DirectoryCreatePort,
} from "../adapters/store-sqlite/file-ops.ts";
import type { OwnedHandle } from "../ports/lifetime.ts";
import type { SqlDatabase, StorePort } from "../ports/store.ts";
import { refuse } from "../core/trust/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { Unavailable } from "../generated/types.ts";

let security: PrivateFileGuard | undefined;
const sqliteStore: StorePort = {
  open(options) {
    if (process.platform === "win32")
      security ??= privateFileGuard(windowsPrivateFiles());
    return createSqliteStore(process.cwd(), security ? { security } : {}).open(
      options,
    );
  },
};

export class StateUnavailable extends ForgeFailure {
  readonly unavailable: Unavailable;
  constructor(unavailable: Unavailable) {
    super({
      code: "UNAVAILABLE",
      message: `${unavailable.reason}; ${unavailable.remedy}`,
      retry: "never",
    });
    this.unavailable = unavailable;
  }
}

interface Entry {
  readonly handle: OwnedHandle<SqlDatabase>;
  readonly owner: StateOwner;
  readonly write: boolean;
  readonly drained: Promise<void>;
  finish(): void;
  refs: number;
  pinned: boolean;
}
/** Separate modes and invocation leases keep promotion from closing a live reader. */
export class LocalState {
  readonly #path: string;
  readonly #store: StorePort;
  readonly #directories: DirectoryCreatePort | undefined;
  readonly #missing: ((write: boolean) => Promise<void>) | undefined;
  readonly #entries = new Map<boolean, Entry>();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(
    path: string,
    store: StorePort = sqliteStore,
    directories?: DirectoryCreatePort,
    missing?: (write: boolean) => Promise<void>,
  ) {
    this.#path = path;
    this.#store = store;
    this.#directories = directories;
    this.#missing = missing;
  }
  #serial<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  /** Reserve a new store atomically; recovery must never open an existing database. */
  async create<T>(initialize: () => Promise<T>): Promise<T> {
    const rollback = await this.#serial(() => {
      if (this.#closed) refuse("UNAVAILABLE", "State lifetime is closed");
      if (process.platform === "win32")
        security ??= privateFileGuard(windowsPrivateFiles());
      const files = security ? securedFileOps(security) : undefined;
      ensurePrivateDirectory(dirname(this.#path), this.#directories);
      try {
        const fd = createPrivateFile(this.#path, "wx", files);
        const identity = fstatSync(fd);
        closeSync(fd);
        return () => removeOwnedFile(this.#path, identity, files);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        refuse(
          "INPUT_CONFLICT",
          `Forge store already exists at ${this.#path}. Fix: keep the existing store, or restore a backup instead.`,
        );
      }
    });
    try {
      return await initialize();
    } catch (error) {
      rollback();
      throw error;
    }
  }
  async #entry(write: boolean): Promise<Entry | undefined> {
    if (this.#closed) refuse("UNAVAILABLE", "State lifetime is closed");
    const current =
      this.#entries.get(true) ??
      (!write ? this.#entries.get(false) : undefined);
    if (current) return current;
    if (!existsSync(this.#path)) {
      await this.#missing?.(write);
      if (!write) return undefined;
    }
    if (write) ensurePrivateDirectory(dirname(this.#path), this.#directories);
    const result = await this.#store.open({
      path: this.#path,
      readOnly: !write,
    });
    if (!result.ok) throw new StateUnavailable(result.unavailable);
    try {
      const owner = new StateOwner(result.handle.value, {
        now: () => Date.now(),
      });
      if (write) owner.initialize();
      let finish!: () => void;
      const drained = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entry: Entry = {
        handle: result.handle,
        owner,
        write,
        drained,
        finish,
        refs: 0,
        pinned: false,
      };
      this.#entries.set(write, entry);
      return entry;
    } catch (error) {
      await result.handle.close();
      throw error;
    }
  }
  /** Trust retains a pinned reader/writer for its synchronous admission checks. */
  open(write: boolean): Promise<StateOwner | undefined> {
    return this.#serial(async () => {
      const entry = await this.#entry(write);
      if (entry && !entry.pinned) {
        entry.pinned = true;
        entry.refs++;
      }
      return entry?.owner;
    });
  }
  acquire(write: boolean): Promise<OwnedHandle<StateOwner | undefined>> {
    return this.#serial(async () => {
      const entry = await this.#entry(write);
      if (entry) entry.refs++;
      let closed = false;
      return {
        ownership: "owned",
        value: entry?.owner,
        close: () =>
          this.#serial(async () => {
            if (closed) return;
            closed = true;
            if (entry) await this.#release(entry);
          }),
      };
    });
  }
  async #release(entry: Entry): Promise<void> {
    if (--entry.refs !== 0) return;
    this.#entries.delete(entry.write);
    try {
      await entry.handle.close();
    } finally {
      entry.finish();
    }
  }
  get current(): StateOwner | undefined {
    return (this.#entries.get(true) ?? this.#entries.get(false))?.owner;
  }
  async close(): Promise<void> {
    this.#closed = true;
    const draining = await this.#serial(async () => {
      const entries = [...this.#entries.values()];
      const outcomes = await Promise.allSettled(
        entries
          .filter((entry) => entry.pinned)
          .map(async (entry) => {
            entry.pinned = false;
            await this.#release(entry);
          }),
      );
      return { entries, outcomes };
    });
    await Promise.all(draining.entries.map((entry) => entry.drained));
    const errors = draining.outcomes.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length) throw new AggregateError(errors, "State close failed");
  }
}
