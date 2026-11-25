import type {
  HostCaller,
  HubCore,
  HubResult,
} from "../../src/contract/core.ts";
import type {
  HookModeOutput,
  HookSessionInput,
  HookSessionOutput,
} from "../../src/contract/hooks.ts";

function result<T>(reply: HubResult<T>): T {
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.value;
}

export class FakeHostBridge {
  private readonly core: HubCore;
  private readonly caller: HostCaller;

  constructor(core: HubCore, caller: HostCaller) {
    this.core = core;
    this.caller = caller;
  }

  start(
    hostSessionId: string,
    source: HookSessionInput["source"] = "startup",
    threadId?: string,
  ): HookSessionOutput {
    return result(
      this.core.hookSession(this.caller, {
        host: "claude",
        hostSessionId,
        source,
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );
  }

  mode(hostSessionId: string): HookModeOutput {
    return result(
      this.core.hookMode(this.caller, { host: "claude", hostSessionId }),
    );
  }
}
