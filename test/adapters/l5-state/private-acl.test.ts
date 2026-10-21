// Windows private ACLs through a fake process port: which programs start, and how failures read.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hardenPrivatePaths } from "../../../src/adapters/store-sqlite/private-acl.ts";
import type { ProcessPort, ProcessResult } from "../../../src/ports/process.ts";

setDefaultTimeout(5000);

const sid = "S-1-5-21-1-2-3-1001";
const env = { SystemRoot: "C:\\Windows", PATH: "C:\\Git\\usr\\bin" };

function fakePort(
  icacls: (args: readonly string[]) => Partial<ProcessResult>,
  user: string = sid,
): {
  readonly port: ProcessPort;
  readonly started: string[];
} {
  const started: string[] = [];
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve: (executable) => ({ kind: "resolved", path: executable }),
    run(executable, args) {
      started.push(executable.path);
      const done = {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 1,
      };
      if (basename(executable.path.replaceAll("\\", "/")) === "whoami.exe")
        return Promise.resolve({
          ...done,
          stdout: `"host\\user","${user}"\r\n`,
        });
      return Promise.resolve({ ...done, ...icacls(args) });
    },
  };
  return { port, started };
}

/** The rejection message, or "resolved" so a missing failure reads plainly. */
function failure(paths: readonly string[], port: ProcessPort): Promise<string> {
  return hardenPrivatePaths(paths, port, env, "win32").then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
}

function withFile(run: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "forge-private-acl-unit-"));
  const file = join(dir, "store");
  writeFileSync(file, "store");
  return run(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("Windows ACLs start only System32 whoami and icacls, never PowerShell", () =>
  withFile(async (file) => {
    const { port, started } = fakePort((args) => {
      if (args[1] === "/save")
        writeFileSync(
          args[2] ?? "",
          `store\r\nD:PAI(A;;FA;;;${sid})\r\n`,
          "utf16le",
        );
      return {};
    });
    await hardenPrivatePaths([file], port, env, "win32");
    expect(started.map((path) => path.replaceAll("/", "\\"))).toEqual([
      "C:\\Windows\\System32\\whoami.exe",
      "C:\\Windows\\System32\\icacls.exe",
      "C:\\Windows\\System32\\icacls.exe",
    ]);
  }));

test("a leftover explicit entry is cleared with /reset and read back again", () =>
  withFile(async (file) => {
    const calls: string[] = [];
    let saves = 0;
    const { port } = fakePort((args) => {
      calls.push(args[1] ?? "");
      if (args[1] === "/save") {
        saves += 1;
        const extra = saves === 1 ? "(A;;FR;;;WD)" : "";
        writeFileSync(
          args[2] ?? "",
          `store\r\nD:PAI(A;;FA;;;${sid})${extra}\r\n`,
          "utf16le",
        );
      }
      return {};
    });
    await hardenPrivatePaths([file], port, env, "win32");
    expect(calls).toEqual([
      "/inheritance:r",
      "/save",
      "/reset",
      "/inheritance:r",
      "/save",
    ]);
  }));

test("a slow icacls is reported as a timeout of icacls", () =>
  withFile(async (file) => {
    const { port } = fakePort(() => ({ exitCode: null, timedOut: true }));
    expect(await failure([file], port)).toBe(
      "Private ACL application or verification failed (icacls.exe timed out)",
    );
  }));

test("a failing icacls keeps its exit code and error output", () =>
  withFile(async (file) => {
    const { port } = fakePort(() => ({
      exitCode: 5,
      stderr: "store: Access is denied.\r\n",
    }));
    expect(await failure([file], port)).toBe(
      "Private ACL application or verification failed (icacls.exe exit 5: store: Access is denied.)",
    );
  }));

test("the built-in Administrator reads back under its SDDL alias LA", () =>
  withFile(async (file) => {
    // A hosted Windows runner runs as runneradmin, the machine's RID-500 account.
    const { port } = fakePort((args) => {
      if (args[1] === "/save")
        writeFileSync(
          args[2] ?? "",
          "store\r\nD:PAI(A;;FA;;;LA)\r\n",
          "utf16le",
        );
      return {};
    }, "S-1-5-21-1-2-3-500");
    expect(await failure([file], port)).toBe("resolved");
  }));

test("LA is refused when the current user is not the built-in Administrator", () =>
  withFile(async (file) => {
    const { port } = fakePort((args) => {
      if (args[1] === "/save")
        writeFileSync(
          args[2] ?? "",
          "store\r\nD:PAI(A;;FA;;;LA)\r\n",
          "utf16le",
        );
      return {};
    });
    expect(await failure([file], port)).toMatch(
      /unexpected ACL D:PAI\(A;;FA;;;LA\)/,
    );
  }));

test("an ACL that reads back with any other entry is refused", () =>
  withFile(async (file) => {
    const { port } = fakePort((args) => {
      if (args[1] === "/save")
        writeFileSync(
          args[2] ?? "",
          `store\r\nD:PAI(A;;FA;;;${sid})(A;;FR;;;WD)\r\n`,
          "utf16le",
        );
      return {};
    });
    expect(await failure([file], port)).toMatch(
      /^Private ACL application or verification failed \(unexpected ACL .*WD/,
    );
  }));
