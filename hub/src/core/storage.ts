import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { createRequire } from "node:module";
import type { DoctorCheck, HubConfig } from "../contract/runtime.ts";
import { protectPath } from "./protect.ts";
import type { RefuseNetworkPath } from "./store.ts";

const refusal = "The data directory must be on a local filesystem.";
const uninitialised = "The database is not initialised.";
type Placement = "network" | "local" | "unknown";
type CheckStatus = DoctorCheck["status"];
const positions: Record<Placement, readonly [CheckStatus, string]> = {
  network: ["action", refusal],
  local: ["ok", "The data directory is on a local filesystem."],
  unknown: ["skipped", "Cannot tell whether the data directory is local."],
};

function placement(dir: string, mounts?: string): Placement {
  const unc = /^(?:\\\\|\/\/)(?:\?[/\\]UNC[/\\])?[^/\\?.][^/\\]*[/\\][^/\\]+/i;
  if (unc.test(dir)) return "network";
  if (mounts === undefined) {
    if (process.platform !== "linux") return "unknown";
    try {
      mounts = readFileSync("/proc/self/mounts", "utf8");
      dir = realpathSync(dir);
    } catch {
      if (mounts === undefined) return "unknown";
    }
  }
  const path = posix.normalize(dir);
  let nearest = "";
  let filesystem = "";
  for (const line of mounts.split("\n")) {
    const [, raw, type] = line.trim().split(/[ \t]+/);
    if (!raw || !type) continue;
    const mount = raw.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (!posix.isAbsolute(mount) || mount.length < nearest.length) continue;
    if (path !== mount && !path.startsWith(mount === "/" ? "/" : mount + "/"))
      continue;
    nearest = mount;
    filesystem = type;
  }
  if (!filesystem) return "unknown";
  const remote = /^(?:nfs4?|cifs|smb3|fuse\.sshfs)$/;
  return remote.test(filesystem) ? "network" : "local";
}

export const refuseNetworkPath: RefuseNetworkPath = (dir, mounts) =>
  placement(dir, mounts) === "network" ? refusal : undefined;

function stat(path: string) {
  try {
    return lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch {
    return null;
  }
}

function row(check: string, status: CheckStatus, detail: string): DoctorCheck {
  return { check, status, detail };
}

function schema(dir: string): DoctorCheck {
  const check = "schema_version";
  const path = join(dir, "hub.sqlite");
  if (stat(path) === undefined) return row(check, "skipped", uninitialised);
  try {
    if (!protectPath(path, "file")) throw new Error("Unverified database.");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const file = stat(path + suffix);
      if (file === null || (file && (!file.isFile() || file.nlink !== 1n)))
        throw new Error("Unsafe database sidecar.");
    }
    const load = createRequire(import.meta.url);
    const sqlite = load("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    try {
      const query = "SELECT value FROM meta WHERE key = 'schema_version'";
      const value: unknown = db.prepare(query).get()?.value;
      const good = "The database schema is compatible.";
      const bad = "The database schema is incompatible.";
      return value === "1" ? row(check, "ok", good) : row(check, "action", bad);
    } finally {
      db.close();
    }
  } catch {
    return row(check, "action", "The database schema could not be read.");
  }
}

export function inspectStorage({ dataDir }: HubConfig): readonly DoctorCheck[] {
  const location = placement(dataDir);
  const safe = location !== "network" && protectPath(dataDir, "dir");
  const check = "data_directory";
  const missing =
    !safe && location !== "network" && stat(dataDir) === undefined;
  const absent = "The data directory is missing.";
  const unavailable = "The data directory is unavailable or unsafe.";
  const dir = safe
    ? row(check, "ok", "The data directory is private.")
    : row(check, "action", missing ? absent : unavailable);
  const area = row("storage_placement", ...positions[location]);
  const note = missing ? uninitialised : "Cannot inspect the database here.";
  const version = safe
    ? schema(dataDir)
    : row("schema_version", "skipped", note);
  const noLock = safe && stat(join(dataDir, "serve.lock")) === undefined;
  const lockAbsent = "The service lock file is absent.";
  const lockUnknown = "Cannot tell whether the service lock is held.";
  const lock = row(
    "service_lock",
    noLock ? "ok" : "skipped",
    noLock ? lockAbsent : lockUnknown,
  );
  return [dir, area, version, lock];
}
