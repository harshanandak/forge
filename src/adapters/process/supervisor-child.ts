import { spawn, type ChildProcess } from "node:child_process";
import { createSupervisorDeadline } from "./supervisor-deadline.ts";

// The host attaches this waiting Windows helper to its Job Object before sending start.
// No target environment, loader option or executable is inherited by the supervisor.
let started = false;
let child: ChildProcess | undefined;
const stopOwnedScope = (): void => {
  // The host owns the Job handle and terminates its tree when this helper exits.
  // Also stop the direct child if host progress or IPC has stalled.
  try {
    child?.kill("SIGKILL");
  } catch {
    // Already stopped; exiting still notifies the owning host.
  }
  process.exit(1);
};
const deadline = createSupervisorDeadline(process.argv[2], {
  now: () => performance.now(),
  schedule(action, ms) {
    setTimeout(action, ms);
  },
  terminate: stopOwnedScope,
});
process.on("message", (value: unknown) => {
  if (
    !deadline.active() ||
    started ||
    value === null ||
    typeof value !== "object"
  )
    return;
  const data = value as Record<string, unknown>;
  if (
    data.kind !== "start" ||
    typeof data.file !== "string" ||
    typeof data.cwd !== "string" ||
    !Array.isArray(data.args) ||
    !data.args.every((arg: unknown) => typeof arg === "string") ||
    data.env === null ||
    typeof data.env !== "object"
  )
    return;
  started = true;
  const command = spawn(data.file, data.args, {
    cwd: data.cwd,
    env: data.env as Record<string, string>,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: data.verbatim === true,
    stdio: [typeof data.stdin === "string" ? "pipe" : "ignore", 1, 2],
  });
  child = command;
  if (typeof data.stdin === "string") {
    command.stdin?.on("error", () => undefined);
    command.stdin?.end(data.stdin);
  }
  command.once("spawn", () =>
    process.send?.({ kind: "started", pid: command.pid }),
  );
  command.once("error", (error: NodeJS.ErrnoException) =>
    process.send?.({
      kind: "failed",
      ...(typeof error.code === "string" ? { errno: error.code } : {}),
    }),
  );
  command.once("exit", (code, signal) =>
    process.send?.({ kind: "exited", code, signal }),
  );
});
process.on("disconnect", stopOwnedScope);
process.send?.({ kind: "ready", residentBytes: process.memoryUsage().rss });
