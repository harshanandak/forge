// Whether a process is still running. process.kill(pid, 0) only says the pid exists: a killed process
// whose parent has not collected it is a zombie, still "there" but no longer running anything.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function stateOf(pid: number): string | undefined {
  if (process.platform === "linux") {
    // /proc/<pid>/stat is "pid (comm) S ..."; comm may hold spaces and parentheses, so cut at the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  }
  if (process.platform === "win32") return undefined;
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return ps.stdout.trim().slice(0, 1) || undefined;
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return stateOf(pid) !== "Z";
  } catch {
    return false;
  }
}
