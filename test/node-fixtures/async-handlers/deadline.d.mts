export interface FixtureClock {
  set(delay: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}
export function awaitDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  label: string,
  options?: {
    readonly clock?: FixtureClock | undefined;
    readonly details?: (() => string) | undefined;
  },
): Promise<T>;
export interface FixtureChild {
  readonly stdin: { end(): unknown; destroy(): unknown } | null;
  readonly stdout: { destroy(): unknown } | null;
  readonly stderr: { destroy(): unknown } | null;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal: "SIGKILL"): unknown;
}
export function closeChild(
  child: FixtureChild,
  exited: Promise<unknown>,
  timeoutMs: number,
  label: string,
  details: () => string,
  clock?: FixtureClock,
): Promise<void>;
