import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import type { DoctorCheck, HubConfig } from "../contract/runtime.ts";
import { protectPath } from "./protect.ts";
import { probeHubSchema } from "./schema-probe.ts";
import { schemaVersion } from "./schema.ts";
import type { RefuseNetworkPath } from "./store.ts";

const refusal = "The data directory must be on a local filesystem.";
const uninitialised = "The database is not initialised.";
const schemaKey = "schema_version";
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
  const path = join(dir, "hub.sqlite");
  const bad = "The database schema is incompatible.";
  const incompatible = row(schemaKey, "action", bad);
  const existing = stat(path);
  if (existing === undefined) return row(schemaKey, "skipped", uninitialised);
  try {
    if (!existing || !protectPath(path, "file"))
      return row(schemaKey, "action", "The database file is not private.");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const file = path + suffix;
      const present = stat(file);
      if (present === null || (present && !protectPath(file, "file")))
        return row(schemaKey, "action", "A sidecar is not private.");
    }
    const sqlite: typeof import("node:sqlite") =
      process.getBuiltinModule("node:sqlite");
    if (!sqlite) return row(schemaKey, "action", "SQLite is unavailable.");
    const version = probeHubSchema(path, existing, (filename) => {
      const db = new sqlite.DatabaseSync(filename, { readOnly: true });
      try {
        return schemaVersion(db);
      } finally {
        db.close();
      }
    });
    if (version !== 1) return incompatible;
    return row(schemaKey, "ok", "The database schema is compatible.");
  } catch {
    return incompatible;
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
  const version = safe ? schema(dataDir) : row(schemaKey, "skipped", note);
  const noLock = safe && stat(join(dataDir, "serve.lock")) === undefined;
  const lockFile = "service_lock";
  const lockUnknown = "Cannot tell whether the service lock is held.";
  const lock = noLock
    ? row(lockFile, "ok", "The service lock file is absent.")
    : row(lockFile, "skipped", lockUnknown);
  return [dir, area, version, lock];
}
