// A PID may remain after termination. Inspection is bounded and unknown states never prove success.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface LivenessPort {
  readonly platform: string;
  probe(pid: number): void;
  readStat(pid: number): string;
  inspect(
    pid: number,
    options: {
      readonly timeout: number;
      readonly killSignal: "SIGKILL";
      readonly maxBuffer: number;
    },
  ): {
    readonly stdout: string;
    readonly status: number | null;
    readonly error?: Error | undefined;
  };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

export function createLivenessProbe(
  port: LivenessPort,
): (pid: number) => boolean {
  return (pid) => {
    try {
      port.probe(pid);
    } catch (error) {
      if (hasCode(error, "ESRCH")) return false;
      throw error;
    }
    if (port.platform === "win32") return true;
    if (port.platform === "linux") {
      let stat: string;
      try {
        stat = port.readStat(pid);
      } catch (error) {
        if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return false;
        throw error;
      }
      const end = stat.lastIndexOf(")");
      const state = stat.slice(end + 2, end + 3);
      if (end < 0 || !/^[A-Z]$/.test(state))
        throw new Error(`Invalid process state for PID ${pid}`);
      return state !== "Z";
    }
    const result = port.inspect(pid, {
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
    });
    if (result.error !== undefined)
      throw new Error(`Process state inspection failed for PID ${pid}`, {
        cause: result.error,
      });
    const state = result.stdout.trim();
    if (result.status === 1 && state === "") return false;
    if (result.status !== 0 || !/^[A-Z]/.test(state))
      throw new Error(`Could not confirm process state for PID ${pid}`);
    return !state.startsWith("Z");
  };
}

export const isRunning = createLivenessProbe({
  platform: process.platform,
  probe(pid) {
    process.kill(pid, 0);
  },
  readStat(pid) {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  },
  inspect(pid, options) {
    return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      ...options,
      encoding: "utf8",
      windowsHide: true,
    });
  },
});
