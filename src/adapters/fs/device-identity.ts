import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  realpathSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import type { DeviceIdentity } from "../../ports/device-identity.ts";
import {
  createPrivateDirectory,
  createPrivateFile,
  publishExclusive,
  removeDurable,
  replaceDurable,
} from "./durable-io.ts";

function code(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function privateDirectory(path: string): void {
  try {
    if (!lstatSync(path).isDirectory())
      throw new Error("Device root must be a directory");
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    privateDirectory(parent);
    try {
      createPrivateDirectory(path);
    } catch (error) {
      if (code(error) !== "EEXIST" || !lstatSync(path).isDirectory())
        throw error;
    }
  }
}

function identity(value: string): string {
  const id = value.trim();
  if (!id || id.length > 256 || /[\s/\\]/.test(id))
    throw new Error("Invalid device identity");
  return id;
}

/** Publish a fully synced private file exclusively; competing creators read the winner. */
export function nodeDeviceIdentity(
  root: string,
  publish: (from: string, to: string) => void = publishExclusive,
): DeviceIdentity {
  const target = join(root, "device-id");
  function read(): string | undefined {
    try {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 257)
        throw new Error("Invalid device identity file");
      return identity(readFileSync(target, "utf8"));
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw new Error(
        "Cannot read the persisted device identity; repair device-id or set FORGE_DEVICE_ID.",
        { cause: error },
      );
    }
  }
  return {
    read,
    acquire() {
      const current = read();
      if (current !== undefined) return current;
      let temporary: string | undefined;
      let stored: string | undefined;
      let failure: Error | undefined;
      try {
        privateDirectory(root);
        temporary = join(root, `.device-id-${randomUUID()}.tmp`);
        const fd = createPrivateFile(temporary, false);
        try {
          const host =
            hostname()
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 219) || "device";
          writeFileSync(fd, `${host}-${randomUUID()}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          publish(temporary, target);
        } catch (error) {
          if (code(error) !== "EEXIST") throw error;
        }
        stored = read();
        if (stored === undefined)
          throw new Error("Missing device identity after publication");
      } catch (error) {
        failure = new Error(
          "Cannot create or read the persisted device identity; repair device-id or set FORGE_DEVICE_ID before claiming.",
          { cause: error },
        );
      }
      if (temporary !== undefined) {
        try {
          removeDurable(temporary);
        } catch (error) {
          if (code(error) !== "ENOENT")
            failure ??= new Error(
              "Cannot finish persisting device identity; repair device-id or set FORGE_DEVICE_ID before claiming.",
              { cause: error },
            );
        }
      }
      if (failure !== undefined) throw failure;
      if (stored === undefined)
        throw new Error(
          "Persisted device identity is unavailable; set FORGE_DEVICE_ID.",
        );
      return stored;
    },
  };
}

import type { DeviceFiles } from "../../ports/device-files.ts";
import { lockDirectory } from "./clone-files.ts";
import { ForgeFailure } from "../../contract/failure.ts";
const refuse = (): never => {
  throw new ForgeFailure({
    code: "ACCOUNT_INTEGRITY",
    message: "Private device files or executable pin failed integrity checks",
    retry: "never",
  });
};
/** The private folder under ~/.forge: account files, or the cloud credential file. */
export type DeviceFilesDirectory = "accounts" | "cloud";
export function createDeviceFiles(
  home: string,
  security?: {
    directory(path: string, created?: boolean): void;
    file(path: string): void;
  },
  folder: DeviceFilesDirectory = "accounts",
): DeviceFiles {
  const parent = join(home, ".forge"),
    root = join(parent, folder);
  // Cloud credentials get the stricter checks; account files keep their existing behaviour.
  const strict = folder === "cloud";
  const foreign = (st: { readonly uid: number }) =>
    strict &&
    typeof process.getuid === "function" &&
    st.uid !== process.getuid();
  /** A native security failure is an integrity refusal, not an ordinary error that could name a path. */
  const secure = (check: () => void) => {
    if (!strict) return check();
    try {
      check();
    } catch {
      refuse();
    }
  };
  // Temp roots are often symlinks (/var on macOS): compare real paths.
  const canonicalBase = (base: string) => {
    try {
      return realpathSync(base);
    } catch {
      return resolve(base);
    }
  };
  const inside = (base: string, path: string) => {
    const r = relative(base, path);
    return (
      r === "" || (!r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r))
    );
  };
  function directory(path: string, create: boolean, owned: boolean) {
    let created = false;
    if (!existsSync(path)) {
      if (!create) return false;
      createPrivateDirectory(path);
      created = true;
    }
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) refuse();
    if (owned) {
      if (foreign(st)) refuse();
      if (security) secure(() => security.directory(path, created));
      else if ((st.mode & 0o077) !== 0) refuse();
    }
    return true;
  }
  function ready(create: boolean) {
    return directory(parent, create, false) && directory(root, create, true);
  }
  /** A plain, single-link, owned, private file; the one check every read and replace shares. */
  function checkFile(path: string) {
    const st = lstatSync(path);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.size > 1048576 ||
      foreign(st)
    )
      refuse();
    if (security) secure(() => security.file(path));
    else if ((st.mode & 0o077) !== 0) refuse();
  }
  const present = (path: string) => {
    if (!strict) return existsSync(path);
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (code(error) === "ENOENT") return false;
      throw error;
    }
  };
  function target(name: string) {
    if (!/^[a-z][a-z.-]*$/.test(name)) refuse();
    return join(root, name);
  }
  return {
    read(name) {
      if (!ready(false)) return undefined;
      const path = target(name);
      if (!present(path)) return undefined;
      checkFile(path);
      return readFileSync(path, "utf8");
    },
    write(name, text, options) {
      ready(true);
      const path = target(name);
      if (!strict) {
        const temporary = path + ".new";
        const fd = createPrivateFile(temporary, false);
        try {
          writeFileSync(fd, text);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        replaceDurable(temporary, path);
        return;
      }
      // Cloud: check the file being replaced, stage a private file, check what was staged, then publish.
      if (options?.force !== true && present(path)) checkFile(path);
      const temporary = `${path}.${randomUUID()}.new`;
      const fd = createPrivateFile(temporary, false);
      try {
        try {
          writeFileSync(fd, text);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        checkFile(temporary);
        if (readFileSync(temporary, "utf8") !== text) refuse();
        replaceDurable(temporary, path);
      } catch (error) {
        try {
          removeDurable(temporary);
        } catch {
          // Already published or gone; the original failure is the one to report.
        }
        throw error;
      }
    },
    lock() {
      ready(true);
      return lockDirectory(join(root, "lock"));
    },
    scratch() {
      ready(true);
      const base = join(root, "scratch");
      directory(base, true, true);
      const path = join(base, randomUUID());
      directory(path, true, true);
      return {
        path,
        remove() {
          rmSync(path, { recursive: true, force: true });
        },
      };
    },
    pin(path, forbidden) {
      if (!isAbsolute(path)) refuse();
      const canonical = realpathSync(path);
      if (
        inside(resolve(root), canonical) ||
        forbidden.some(
          (base) => base && inside(canonicalBase(base), canonical),
        ) ||
        /[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(canonical)
      )
        refuse();
      for (
        let dir = dirname(canonical);
        dirname(dir) !== dir;
        dir = dirname(dir)
      )
        if (existsSync(join(dir, ".git"))) refuse();
      const st = lstatSync(canonical);
      if (!st.isFile() || st.isSymbolicLink()) refuse();
      return { path: canonical, size: st.size, mtimeMs: st.mtimeMs };
    },
  };
}
