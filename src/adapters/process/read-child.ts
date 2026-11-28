import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ResultEnvelope } from "../../generated/types.ts";
import { within } from "./process-tree.ts";

type Warning = ResultEnvelope["warnings"][number];
export type ReadChild<Input, Output> = {
  read(input: Input): Promise<Output>;
  close(deadline: number): Promise<Warning | undefined>;
};

const filesystemEnvironment = new Set([
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
]);

export function openReadChild<Input extends object, Output>(
  module: URL,
  signal: AbortSignal,
): ReadChild<Input, Output> {
  signal.throwIfAborted();
  const child = fork(fileURLToPath(module), [], {
    execArgv: [],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        filesystemEnvironment.has(name.toUpperCase()),
      ),
    ),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const closed = Promise.withResolvers<void>();
  let reaped = false;
  let pending: ReturnType<typeof Promise.withResolvers<Output>> | undefined;
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null && !child.killed)
      child.kill("SIGKILL");
  };
  child.on("error", (error) => pending?.reject(error));
  child.on("message", (value: Output) => pending?.resolve(value));
  child.once("close", () => {
    reaped = true;
    signal.removeEventListener("abort", stop);
    pending?.reject(new Error("Advisory reader closed"));
    closed.resolve();
  });
  signal.addEventListener("abort", stop, { once: true });
  return {
    async read(input) {
      signal.throwIfAborted();
      if (pending || !child.connected)
        throw new Error("Advisory reader unavailable");
      const request = Promise.withResolvers<Output>();
      pending = request;
      try {
        child.send(input, (error) => {
          if (error) request.reject(error);
        });
        return await request.promise;
      } finally {
        pending = undefined;
      }
    },
    async close(deadline) {
      stop();
      await within(closed.promise, Math.floor(deadline - performance.now()));
      if (reaped || child.pid === undefined) return;
      child.unref();
      child.channel?.unref();
      return {
        code: "PROCESS_SUPERVISION",
        message: JSON.stringify({
          commandPid: child.pid,
          confirmed: false,
          killSent: child.killed,
          reaped: false,
        }),
      };
    },
  };
}
