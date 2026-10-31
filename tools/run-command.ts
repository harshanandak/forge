import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) {
  // sh preserves JSON arguments in extensionless shims on Windows.
  if (["forge", "gh"].includes(command) && process.platform === "win32") {
    const path =
      Object.entries(process.env).find(
        ([key]) => key.toLowerCase() === "path",
      )?.[1] ?? "";
    const shim = path
      .split(delimiter)
      .map((part) => join(part.replace(/^"|"$/g, ""), command))
      .find(existsSync);
    if (!shim && command === "forge")
      throw new Error("installed forge shell shim was not found on PATH");
    if (shim) {
      args = [shim, ...args];
      command = "sh";
    }
  }
  return spawnSync(command, args, options);
}
