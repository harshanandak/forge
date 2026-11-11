export interface ExecutablePin {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}
/** Private device documents, independent of the accepted-state store. */
export interface DeviceFiles {
  read(name: string): string | undefined;
  /**
   * Replace atomically. `force` skips the check of the file being replaced, for a caller that is
   * restoring a document it knows is good; the new file is still checked before it is published.
   */
  write(
    name: string,
    text: string,
    options?: { readonly force?: boolean },
  ): void;
  lock(): { release(): void };
  pin(path: string, forbidden: readonly string[]): ExecutablePin;
  /** A fresh, empty private directory in the device root; remove() deletes it and its contents. */
  scratch(): { readonly path: string; remove(): void };
}
