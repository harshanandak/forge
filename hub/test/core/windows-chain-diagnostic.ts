import { spawnSync } from "node:child_process";
import {
  createPathProtection,
  type ProtectionDeps,
} from "../../src/core/protect.ts";

const prefix = "HUB_WINDOWS_CHAIN_REFUSAL ";

const execute: ProtectionDeps["execute"] = (exe, args, options) => {
  if (typeof options.input !== "string") throw new Error("Expected request");
  const request: unknown = JSON.parse(
    Buffer.from(options.input, "base64").toString("utf8"),
  );
  if (
    !request ||
    typeof request !== "object" ||
    !("path" in request) ||
    typeof request.path !== "string"
  )
    throw new Error("Expected chain path");
  const input = Buffer.from(
    JSON.stringify({ ...request, diagnoseChain: true }),
  ).toString("base64");
  const result = spawnSync(exe, args, { ...options, input });
  if (
    result.status !== 0 ||
    result.error ||
    result.stderr ||
    result.stdout?.trim() !== "private"
  ) {
    const reports =
      result.stderr?.split(/\r?\n/).filter((line) => line.startsWith(prefix)) ??
      [];
    if (reports.length) {
      for (const report of reports) console.error(report);
    } else {
      console.error(
        prefix +
          JSON.stringify({
            component: request.path,
            ownerSID: null,
            clause: result.error ? "helper-execution" : "helper-refused",
            ace: null,
          }),
      );
    }
  }
  return result;
};

export const diagnosticChain =
  process.platform === "win32"
    ? createPathProtection({ execute }).protectDirectoryChain
    : undefined;
