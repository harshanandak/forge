import type { HubCore } from "../contract/core.ts";
import { LIMITS } from "../contract/mcp.ts";
import type { CoreContext } from "./core.ts";
import { delivery, refused } from "./inbox.ts";

type Waiter = {
  person: string;
  session: string;
  project?: string;
  wake: () => void;
};

export function createWaiters() {
  const pending = new Set<Waiter>();
  return {
    pending,
    wake(person: string, project: string, session?: string) {
      let found = false;
      for (const waiter of pending) {
        if (
          waiter.person !== person ||
          (session === undefined
            ? waiter.project !== undefined && waiter.project !== project
            : waiter.session !== session)
        )
          continue;
        waiter.wake();
        found = true;
      }
      return found;
    },
  };
}

export function createWait(ctx: CoreContext): HubCore["wait"] {
  return async (caller, input, signal) => {
    const timeout = input.timeoutMs ?? LIMITS.waitDefaultMs;
    if (
      !Number.isInteger(timeout) ||
      timeout < LIMITS.waitMinMs ||
      timeout > LIMITS.waitMaxMs
    )
      return refused("INPUT_INVALID", "/timeoutMs");
    const end = performance.now() + timeout;
    let next = input;
    for (;;) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const wake = () => resolve();
      const project = ctx.store.sessions.session(input.sessionId)?.projectId;
      const waiter: Waiter = {
        person: caller.person.personId,
        session: input.sessionId,
        wake,
        ...(project === undefined ? {} : { project }),
      };
      ctx.waiters.pending.add(waiter);
      try {
        const result = delivery(ctx, caller, next, { token: true, signal });
        if (!result.ok) return result;
        const { items, answers, mode } = result.value;
        const ready = items.length > 0 || answers.length > 0;
        if (ready || signal.aborted || performance.now() >= end)
          return {
            ok: true,
            value: {
              status: ready ? "ready" : "pending",
              items,
              answers,
              mode,
            },
          };
        const timer = setTimeout(wake, end - performance.now());
        signal.addEventListener("abort", wake, { once: true });
        try {
          await promise;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
        }
        next = { sessionId: input.sessionId };
      } finally {
        ctx.waiters.pending.delete(waiter);
      }
    }
  };
}
