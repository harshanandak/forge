import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { windowsProcessStartTime } from "./windows-job.ts";
import type { Unavailable } from "../../generated/types.ts";
import type { ResolvedExecutable } from "../../ports/process.ts";
import { envValue } from "./env.ts";
import { pathFor, type Platform } from "./platform.ts";

/** The only file probes resolution needs; injectable so the rules are testable for any platform. */
export interface FileProbe {
  isFile(path: string): boolean;
  isExecutable(path: string): boolean;
}

export const realFileProbe: FileProbe = {
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** Unknown identities preserve the lock; only two observed start times can prove reuse. */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === "win32") {
      const value = windowsProcessStartTime(pid);
      return value ? `win32-filetime-v1:${value}` : undefined;
    }
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const value = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return value && /^[1-9]\d*$/.test(value)
        ? `linux-starttime-v1:${value}`
        : undefined;
    }
    if (process.platform === "darwin") {
      const result = spawnSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 1000,
          maxBuffer: 1024,
          env: { LC_ALL: "C", TZ: "UTC0" },
        },
      );
      if (result.status !== 0) return undefined;
      const value = result.stdout.trim();
      if (
        !/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
          value,
        )
      )
        return undefined;
      const instant = Date.parse(value + " UTC");
      return Number.isFinite(instant)
        ? `darwin-lstart-utc-v1:${new Date(instant).toISOString()}`
        : undefined;
    }
  } catch {
    // Permission failures and unavailable platform probes never authorize reclamation.
  }
  return undefined;
}

/**
 * Extensions Windows can start. PATHEXT also lists `.VBS`, `.JS` and friends, which CreateProcess
 * cannot run, so only these are ever returned. An extensionless file is never one of them: the
 * POSIX shim next to `npm.cmd` is a shell script and starting it fails (old issue 9997d516).
 */
export const WINDOWS_RUNNABLE: readonly string[] = [
  ".com",
  ".exe",
  ".bat",
  ".cmd",
];

function unavailable(reason: string, remedy: string): Unavailable {
  return { kind: "unavailable", reason, remedy };
}

function windowsExtensions(env: Readonly<Record<string, string>>): string[] {
  const raw = envValue(env, "PATHEXT", "win32");
  if (raw === undefined || raw.trim() === "") return [...WINDOWS_RUNNABLE];
  const listed = raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => WINDOWS_RUNNABLE.includes(ext));
  return [...new Set(listed)];
}

function searchDirectories(
  env: Readonly<Record<string, string>>,
  platform: Platform,
): string[] {
  const raw = envValue(env, "PATH", platform) ?? "";
  const separator = platform === "win32" ? ";" : ":";
  return raw
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

/**
 * Find an executable by walking PATH (and on Windows PATHEXT) ourselves, never through `where` or
 * `which`. The current directory is never searched. A name with a directory part must be absolute.
 */
export function resolveExecutable(
  executable: string,
  env: Readonly<Record<string, string>>,
  platform: Platform,
  probe: FileProbe,
): ResolvedExecutable | Unavailable {
  const path = pathFor(platform);
  const windows = platform === "win32";
  if (
    executable === "" ||
    executable.includes("\0") ||
    (windows && /[<>"|?*]/.test(executable))
  ) {
    return unavailable(
      `"${executable}" is not a usable executable name`,
      "Pass a command name such as git, or an absolute path to the program.",
    );
  }

  const hasDirectory = windows
    ? /[\\/]/.test(executable) || /^[A-Za-z]:/.test(executable)
    : executable.includes("/");
  if (hasDirectory && !path.isAbsolute(executable)) {
    return unavailable(
      `"${executable}" is a relative path, so there is no folder to resolve it against`,
      "Pass a bare command name to search PATH, or an absolute path.",
    );
  }

  const extensions = windows ? windowsExtensions(env) : [];
  const withExtension = windows
    ? WINDOWS_RUNNABLE.includes(path.extname(executable).toLowerCase())
    : false;

  const candidatesIn = (directory: string): string[] => {
    const base = hasDirectory ? executable : path.join(directory, executable);
    if (!windows) return [base];
    const suffixed = extensions.map((ext) => `${base}${ext}`);
    return withExtension ? [base, ...suffixed] : suffixed;
  };

  const directories = hasDirectory
    ? [path.dirname(executable)]
    : searchDirectories(env, platform);
  for (const directory of directories) {
    for (const candidate of candidatesIn(directory)) {
      if (!probe.isFile(candidate)) continue;
      if (!windows && !probe.isExecutable(candidate)) continue;
      return { kind: "resolved", path: candidate };
    }
  }

  return unavailable(
    hasDirectory
      ? `no runnable file at "${executable}"`
      : `"${executable}" was not found on PATH`,
    hasDirectory
      ? "Check the path, or on POSIX that the file has its execute permission."
      : `Install ${executable} or add the folder that holds it to PATH.`,
  );
}
