import { spawn } from "node:child_process";

// The host attaches this waiting helper to its group/job/cgroup before sending start.
// No target environment, loader option or executable is inherited by the supervisor.
let started = false;
process.on("message", (value: unknown) => {
  if (started || value === null || typeof value !== "object") return;
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
  const child = spawn(data.file, data.args, {
    cwd: data.cwd,
    env: data.env as Record<string, string>,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: data.verbatim === true,
    stdio: [typeof data.stdin === "string" ? "pipe" : "ignore", 1, 2],
  });
  if (typeof data.stdin === "string") {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(data.stdin);
  }
  child.once("spawn", () =>
    process.send?.({ kind: "started", pid: child.pid }),
  );
  child.once("error", (error: NodeJS.ErrnoException) =>
    process.send?.({
      kind: "failed",
      ...(typeof error.code === "string" ? { errno: error.code } : {}),
    }),
  );
  child.once("exit", (code, signal) =>
    process.send?.({ kind: "exited", code, signal }),
  );
});
process.on("disconnect", () => {
  // Parent death releases a Windows Job handle. POSIX needs to stop its owned group too.
  if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  } else process.exit(1);
});
process.send?.({ kind: "ready", residentBytes: process.memoryUsage().rss });
