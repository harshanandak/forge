import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceIdentity } from "../../ports/device-identity.ts";
import {
  createPrivateDirectory,
  createPrivateFile,
  publishExclusive,
  removeDurable,
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
          writeFileSync(fd, `device-${randomUUID()}\n`);
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
