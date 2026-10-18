// Opening several owned resources together: if one fails, everything already opened is closed in
// reverse order before the failure is returned, so a partial open never leaks.
import type { Unavailable } from "../generated/types.ts";
import type {
  BorrowedHandle,
  LifetimeProvider,
  OwnedHandle,
} from "../ports/lifetime.ts";

export function borrow<T>(value: T): BorrowedHandle<T> {
  return { ownership: "borrowed", value };
}

export interface OpenStep<T, Options> {
  readonly provider: LifetimeProvider<T, Options>;
  readonly options: Options;
}

export type OpenAllResult =
  | {
      readonly ok: true;
      readonly handles: readonly OwnedHandle<unknown>[];
      close(): Promise<void>;
    }
  | {
      readonly ok: false;
      readonly unavailable: Unavailable;
      readonly failedAt: number;
    };

async function closeAll(
  handles: readonly OwnedHandle<unknown>[],
): Promise<void> {
  for (const handle of [...handles].reverse()) await handle.close();
}

export async function openAll(
  steps: readonly OpenStep<unknown, never>[],
): Promise<OpenAllResult> {
  const opened: OwnedHandle<unknown>[] = [];
  for (const [index, step] of steps.entries()) {
    const result = await step.provider.open(step.options);
    if (!result.ok) {
      await closeAll(opened);
      return { ok: false, unavailable: result.unavailable, failedAt: index };
    }
    opened.push(result.handle);
  }
  return { ok: true, handles: opened, close: () => closeAll(opened) };
}
