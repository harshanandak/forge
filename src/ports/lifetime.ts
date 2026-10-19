// Owner/lifetime port for built-in stateful providers only (store, process supervisor, MCP
// transport). A handle is either owned (the holder must close it) or borrowed (someone else will).
// Outside block authors get no setup or dispose hooks.
import type { Unavailable } from "../generated/types.ts";

export interface OwnedHandle<T> {
  readonly ownership: "owned";
  readonly value: T;
  /** Idempotent; releases everything open() acquired. */
  close(): Promise<void>;
}

export interface BorrowedHandle<T> {
  readonly ownership: "borrowed";
  readonly value: T;
}

export type Handle<T> = OwnedHandle<T> | BorrowedHandle<T>;

/** A failed open has already released whatever it acquired before failing. */
export type OpenResult<T> =
  | { readonly ok: true; readonly handle: OwnedHandle<T> }
  | { readonly ok: false; readonly unavailable: Unavailable };

export interface LifetimeProvider<T, Options> {
  open(options: Options): Promise<OpenResult<T>>;
}
