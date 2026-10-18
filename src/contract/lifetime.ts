// Opening several owned resources together: if one fails, everything already opened is closed in
// reverse order before the failure is returned, so a partial open never leaks.
import type { Unavailable } from "../generated/types.ts";
import type {
  BorrowedHandle,
  LifetimeProvider,
  OpenResult,
  OwnedHandle,
} from "../ports/lifetime.ts";

export function borrow<T>(value: T): BorrowedHandle<T> {
  return { ownership: "borrowed", value };
}

/**
 * One provider paired with the options it will be opened with, its types erased so providers with
 * different options can sit in one list. Build it with `step`, which keeps the pairing checked.
 */
export interface OpenStep {
  open(): Promise<OpenResult<unknown>>;
}

export function step<T, Options>(
  provider: LifetimeProvider<T, Options>,
  options: Options,
): OpenStep {
  return { open: () => provider.open(options) };
}

export type OpenAllResult =
  | {
      readonly ok: true;
      readonly handles: readonly OwnedHandle<unknown>[];
      /** Closes every handle, last opened first; rejects with an AggregateError if any close failed. */
      close(): Promise<void>;
    }
  | {
      readonly ok: false;
      readonly unavailable: Unavailable;
      readonly failedAt: number;
      /** What went wrong closing the handles already opened, if anything. */
      readonly cleanupErrors: readonly unknown[];
    };

/** Close every handle in reverse order, whatever happens; returns each failure. */
async function closeAll(
  handles: readonly OwnedHandle<unknown>[],
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export async function openAll(
  steps: readonly OpenStep[],
): Promise<OpenAllResult> {
  const opened: OwnedHandle<unknown>[] = [];
  for (const [index, openStep] of steps.entries()) {
    const result = await openStep.open();
    if (!result.ok) {
      const cleanupErrors = await closeAll(opened);
      return {
        ok: false,
        unavailable: result.unavailable,
        failedAt: index,
        cleanupErrors,
      };
    }
    opened.push(result.handle);
  }
  return {
    ok: true,
    handles: opened,
    close: async () => {
      const failures = await closeAll(opened);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} of ${opened.length} handles failed to close`,
        );
      }
    },
  };
}
