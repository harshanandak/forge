import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { StateOwner } from "../core/state/index.ts";
import { sqliteStore } from "../adapters/store-sqlite/index.ts";
import type { Handle } from "../ports/lifetime.ts";
import type { SqlDatabase } from "../ports/store.ts";
import { refuse } from "../core/trust/index.ts";

/** A read never creates a store; writes reopen through the same state owner. */
export class LocalState {
  readonly #path: string;
  #handle: Handle<SqlDatabase> | undefined;
  #owner: StateOwner | undefined;
  #writable = false;
  constructor(path: string) {
    this.#path = path;
  }
  async open(write: boolean): Promise<StateOwner | undefined> {
    if (this.#owner && (!write || this.#writable)) return this.#owner;
    if (!write && !existsSync(this.#path)) return undefined;
    await this.close();
    if (write) mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const result = await sqliteStore.open({
      path: this.#path,
      readOnly: !write,
    });
    if (!result.ok) refuse("UNAVAILABLE", result.unavailable.reason);
    this.#handle = result.handle;
    try {
      this.#owner = new StateOwner(result.handle.value, {
        now: () => Date.now(),
      });
      if (write) this.#owner.initialize();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.#writable = write;
    return this.#owner;
  }
  get current(): StateOwner | undefined {
    return this.#owner;
  }
  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    this.#owner = undefined;
    this.#writable = false;
    if (handle?.ownership === "owned") await handle.close();
  }
}
