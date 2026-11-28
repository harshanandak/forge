import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { windowsProcessStartTime } from "./windows-job.ts";
import type { Unavailable } from "../../generated/types.ts";
import type { ResolvedExecutable } from "../../ports/process.ts";
import { envValue } from "./env.ts";
import { pathFor, type Platform } from "./platform.ts";

/** The only file probes resolution needs; injectable so the rules are testable for any platform. */
export interface FileProbe {
  isFile(path: string): boolean;
  isExecutable(path: string): boolean;
  realpath(path: string): string;
  hasEntry(path: string): boolean;
}

export const realFileProbe: FileProbe = {
  realpath: (path) => realpathSync.native(path),
  hasEntry(path) {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  },
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
function searchExecutable(
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

const gitPaths = new WeakMap<FileProbe, Map<Platform, ResolvedExecutable>>();

/** Filesystem-only admission, including lexical ancestors of links pointing outside a checkout. */
function outsideRepository(
  directory: string,
  platform: Platform,
  probe: FileProbe,
  env: Readonly<Record<string, string>>,
): boolean {
  const path = pathFor(platform);
  const temporary = [
    tmpdir(),
    ...["TEMP", "TMP", "TMPDIR"].map((name) => envValue(env, name, platform)),
  ]
    .filter((value): value is string => !!value)
    .flatMap((value) => [path.resolve(value), probe.realpath(value)]);
  for (let at = directory; ; at = path.dirname(at)) {
    if (
      temporary.some((value) => path.relative(value, at) === "") ||
      /[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(at)
    )
      return false;
    if (probe.hasEntry(path.join(at, ".git"))) return false;
    if (
      probe.hasEntry(path.join(at, ".forge")) &&
      (path.relative(probe.realpath(homedir()), probe.realpath(at)) !== "" ||
        ["config.yaml", "project.json"].some((marker) =>
          probe.hasEntry(path.join(at, ".forge", marker)),
        ))
    )
      return false;
    if (path.dirname(at) === at) return true;
  }
}

/** Git is pinned once per process; injected filesystem probes have independent caches. */
export function resolveExecutable(
  executable: string,
  env: Readonly<Record<string, string>>,
  platform: Platform,
  probe: FileProbe,
): ResolvedExecutable | Unavailable {
  const path = pathFor(platform);
  const windows = platform === "win32";
  const name = path.basename(executable);
  if (!(windows ? /^git(?:\.(?:exe|com|cmd|bat))?$/i : /^git$/).test(name))
    return searchExecutable(executable, env, platform, probe);
  const cached = gitPaths.get(probe)?.get(platform);
  if (cached) return cached;
  const explicit = executable !== name;
  const entries = explicit
    ? [path.dirname(executable)]
    : (envValue(env, "PATH", platform) ?? "").split(windows ? ";" : ":");
  let skipped = 0;
  for (const entry of entries) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    try {
      if (
        !path.isAbsolute(directory) ||
        (windows &&
          !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(directory))
      )
        throw new Error("relative PATH");
      const canonical = probe.realpath(directory);
      if (
        ![path.resolve(directory), canonical].every((dir) =>
          outsideRepository(dir, platform, probe, env),
        )
      )
        throw new Error("repository PATH");
      // Git for Windows ships a native executable. Never route Git through a batch interpreter.
      const found = searchExecutable(
        executable,
        { PATH: canonical, PATHEXT: ".EXE;.COM" },
        platform,
        probe,
      );
      if (found.kind !== "resolved") continue;
      const resolved = probe.realpath(found.path);
      if (
        !outsideRepository(path.dirname(resolved), platform, probe, env) ||
        (windows && !/\.(?:exe|com)$/i.test(resolved))
      )
        throw new Error("repository or batch Git");
      const result: ResolvedExecutable = Object.freeze({
        kind: "resolved",
        path: resolved,
      });
      const cache =
        gitPaths.get(probe) ?? new Map<Platform, ResolvedExecutable>();
      cache.set(platform, result);
      gitPaths.set(probe, cache);
      return result;
    } catch {
      skipped++;
    }
  }
  return unavailable(
    `Git is unavailable (${skipped} skipped PATH entries).`,
    "Install Git outside any repository, temporary directory and node_modules/.bin, and add its absolute directory to PATH.",
  );
}

const systemGit = "/usr/bin/git";
const gitManifest = "/var/lib/dpkg/info/git.md5sums";

async function readManagedFile(path: string, max: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.uid !== 0n ||
      info.mode & 0o022n ||
      info.size > max
    )
      return;
    const data = await handle.readFile();
    if (BigInt(data.length) === info.size) return { data, info };
  } finally {
    await handle.close();
  }
}

export async function proveAdvisoryGit(
  executable: ResolvedExecutable,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<
  { executable: ResolvedExecutable; unchanged(): boolean } | undefined
> {
  if (platform !== "linux" || executable.path !== systemGit) return;
  try {
    for (const path of [
      "/usr",
      "/usr/bin",
      "/var",
      "/var/lib",
      "/var/lib/dpkg",
      "/var/lib/dpkg/info",
    ]) {
      signal.throwIfAborted();
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022) return;
    }
    signal.throwIfAborted();
    const manifest = await readManagedFile(gitManifest, 128 * 1024);
    const expected = manifest?.data
      .toString("ascii")
      .match(/^([a-f0-9]{32}) {2}usr\/bin\/git$/m)?.[1];
    if (!expected || signal.aborted) return;
    const git = await readManagedFile(systemGit, 16 * 1024 * 1024);
    if (
      !git ||
      signal.aborted ||
      git.data.readUInt32BE(0) !== 0x7f454c46 ||
      createHash("md5").update(git.data).digest("hex") !== expected
    )
      return;
    const unchanged = () => {
      try {
        const current = lstatSync(systemGit, { bigint: true });
        const previous = git.info;
        return (
          current.isFile() &&
          current.dev === previous.dev &&
          current.ino === previous.ino &&
          current.size === previous.size &&
          current.mtimeNs === previous.mtimeNs &&
          current.ctimeNs === previous.ctimeNs
        );
      } catch {
        return false;
      }
    };
    if (unchanged()) return { executable, unchanged };
  } catch {
    return;
  }
}
