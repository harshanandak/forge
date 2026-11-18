import type { HookGuardPort } from "../../ports/hook-guard.ts";

type GuardCall = { input: unknown; services: { guard: HookGuardPort } };
type InspectCall = GuardCall & { input: { path: string } };

module.exports = {
  "guard.command": ({ input, services }: GuardCall) =>
    services.guard.command(input),
  "guard.output": ({ input, services }: GuardCall) =>
    services.guard.output(input),
  "safe-inspect.metadata": ({ input, services }: InspectCall) =>
    services.guard.inspect("metadata", input.path),
  "safe-inspect.summary": ({ input, services }: InspectCall) =>
    services.guard.inspect("summary", input.path),
};
