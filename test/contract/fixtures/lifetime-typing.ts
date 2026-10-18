// Compiled by `bun check`, never imported at runtime by the contract: a real multi-step open with
// providers whose options differ must type-check without casts, and a mismatched pairing must not.
import { openAll, step } from "../../../src/contract/index.ts";
import type { LifetimeProvider } from "../../../src/ports/index.ts";

interface StoreOptions {
  readonly path: string;
}
interface ServeOptions {
  readonly port: number;
}

declare const store: LifetimeProvider<{ readonly kind: "store" }, StoreOptions>;
declare const serve: LifetimeProvider<{ readonly kind: "serve" }, ServeOptions>;

export function openRealSteps() {
  return openAll([
    step(store, { path: ".forge/state" }),
    step(serve, { port: 7000 }),
  ]);
}

export function openWithWrongOptions() {
  return openAll([
    // @ts-expect-error the store takes a path, not a port
    step(store, { port: 7000 }),
  ]);
}
