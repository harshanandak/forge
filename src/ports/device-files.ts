export interface ExecutablePin {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}
/** Private device documents, independent of the accepted-state store. */
export interface DeviceFiles {
  read(name: string): string | undefined;
  write(name: string, text: string): void;
  lock(): { release(): void };
  pin(path: string, forbidden: readonly string[]): ExecutablePin;
}
