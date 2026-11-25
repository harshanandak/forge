import type { HubCore, HubResult } from "../../src/contract/core.ts";
import type {
  DoorbellPayload,
  DoorbellPort,
} from "../../src/contract/hooks.ts";
import { expect } from "bun:test";
import type { CoreBase } from "../../src/core/core.ts";

export function doorbellFake(configured: boolean) {
  const rings: DoorbellPayload[] = [];
  const port: DoorbellPort = {
    configured: () => configured,
    ring: (payload) => {
      rings.push(payload);
      return Promise.resolve({ kind: "sent", status: 202 });
    },
  };
  return { port, rings };
}

export function fakeHostCore(
  base: Pick<CoreBase, "hookSession" | "hookMode">,
): HubCore {
  const unused = (): never => {
    throw new Error("Unexpected fixture call");
  };
  return {
    ...base,
    chatHandlers: {
      onMessage: unused,
      onMessageChange: unused,
      onAction: unused,
    },
    findToken: unused,
    createToken: unused,
    revokeToken: unused,
    findHostKey: unused,
    createHostKey: unused,
    revokeHostKey: unused,
    person: unused,
    hello: unused,
    inbox: unused,
    wait: unused,
    ask: unused,
    send: unused,
    reply: unused,
    report: unused,
    cliInbox: unused,
    cliSend: unused,
    hookStop: unused,
    start: unused,
    close: unused,
  };
}

export function refusal(result: HubResult<unknown>) {
  if (result.ok) throw new Error("Expected a refusal");
  return result.error;
}

export async function until(check: () => boolean, timeout: number) {
  const end = performance.now() + timeout;
  while (!check() && performance.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}
