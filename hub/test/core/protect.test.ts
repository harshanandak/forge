/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createPathProtection,
  UnverifiedDirectoryCreation,
  type ProtectionDeps,
} from "../../src/core/protect.ts";
import {
  fileText,
  protectionFixture,
  timeout,
  verifyCreation,
} from "./protect-fixture.ts";

const { temp, cleanup } = protectionFixture();

afterEach(cleanup);

function fakeMacStat(path: string) {
  const stat = lstatSync(path);
  stat.uid = 123;
  stat.mode = (stat.mode & ~0o7777) | (stat.isDirectory() ? 0o700 : 0o600);
  return stat;
}

const noMacAcl = "drwx------  2 owner group 64 Nov 23 12:00 private\n";
const macAcl =
  "drwx------+ 2 owner group 64 Nov 23 12:00 private\n 0: user:other allow read\n";

test("distinguishes adjacent large file IDs", () => {
  let ino = 2n ** 53n;
  const guard = createPathProtection({
    platform: "linux",
    geteuid: () => 123,
    lstat: fakeMacStat,
    preciseLstat: (path) =>
      Object.assign(lstatSync(path, { bigint: true }), {
        uid: 123n,
        mode: 0o700n,
        ino: ino++,
      }),
  });
  expect(guard.protectPath(temp(), "dir")).toBe(false);
});

test.each(["linux", "win32"] as const)(
  "%s reports incomplete directory creation",
  async (platform) => {
    const guard = createPathProtection({
      platform,
      lstat() {
        throw new Error("stat failed");
      },
      execute: () => ({
        status: 1,
        stdout: "published_unverified",
        stderr: "",
      }),
    });
    await expect(
      guard.createPrivateDirectory(join(temp(), "private")),
    ).rejects.toBeInstanceOf(UnverifiedDirectoryCreation);
  },
);

test.skipIf(process.platform === "win32")(
  "keeps a replacement if file stat fails",
  async () => {
    const path = join(temp(), "private");
    const guard = createPathProtection({
      platform: "linux",
      statFile() {
        renameSync(path, path + ".original");
        writeFileSync(path, fileText);
        throw new Error("stat failed");
      },
    });
    expect(await guard.createPrivateFile(path)).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(fileText);
  },
);

test.each([
  ["group:everyone deny delete", true],
  ["user:owner allow writesecurity", true],
  ["user:other allow delete_child", false],
  ["user:other inherited allow add_file,add_subdirectory", true],
] as const)(
  "macOS directory chain checks ancestor ACE %s",
  (ace, expected) => {
    const path = realpathSync(temp());
    const ancestor = dirname(path);
    const mac = createPathProtection({
      platform: "darwin",
      lstat: fakeMacStat,
      geteuid: () => 123,
      now: () => 100,
      execute(exe, args) {
        if (exe === "/usr/bin/id") {
          expect(args[0]).toBe("-u");
          return {
            status: 0,
            stdout: args[1] === "owner" ? "123\n" : "456\n",
            stderr: "",
          };
        }
        expect(exe).toBe("/bin/ls");
        const stdout =
          args[1] === ancestor
            ? `${noMacAcl.replace("drwx------ ", "drwx------+ ")} 0: ${ace}\n`
            : noMacAcl;
        return { status: 0, stdout, stderr: "" };
      },
    });
    expect(mac.protectDirectoryChain(path)).toBe(expected);
  },
  timeout,
);

test(
  "PP2: accepts macOS read-back only for a private path without ACL entries",
  () => {
    const path = temp();
    for (const [stdout, expected] of [
      [noMacAcl, true],
      [macAcl, false],
      ["unparseable\n", false],
    ] as const) {
      const calls: [string, readonly string[]][] = [];
      const mac = createPathProtection({
        platform: "darwin",
        lstat: fakeMacStat,
        geteuid: () => 123,
        now: () => 100,
        execute(exe, args, options) {
          calls.push([exe, args]);
          expect(options.shell).toBe(false);
          return { status: 0, stdout, stderr: "" };
        },
      });
      expect(mac.protectPath(path, "dir")).toBe(expected);
      expect(calls).toEqual([["/bin/ls", ["-lde", path]]]);
    }
  },
  timeout,
);

test(
  "PP3: Windows verification requires the success marker, zero status and empty stderr",
  () => {
    const path = resolve(temp(), "name [with spaces] & apostrophe's file");
    writeFileSync(path, fileText);
    type Result = ReturnType<ProtectionDeps["execute"]>;
    const cases: readonly [string, Result, boolean][] = [
      [
        "protected owner-only DACL",
        { status: 0, stdout: "private\n", stderr: "" },
        true,
      ],
      ["extra ACE", { status: 1, stdout: "refused\n", stderr: "" }, false],
      ["inherited ACE", { status: 1, stdout: "refused\n", stderr: "" }, false],
      [
        "successful stdout with stderr",
        { status: 0, stdout: "private\n", stderr: "unexpected error\n" },
        false,
      ],
      [
        "timeout",
        { status: null, stdout: "", stderr: "", error: new Error("timeout") },
        false,
      ],
      [
        "unexpected response",
        { status: 0, stdout: "unparseable\n", stderr: "" },
        false,
      ],
    ];
    for (const [reason, result, expected] of cases) {
      let called = false;
      const protector = createPathProtection({
        platform: "win32",
        now: () => 100,
        execute(exe, args, options) {
          called = true;
          expect(exe.toLowerCase()).toEndWith("powershell.exe");
          expect(args).toContain("-NoProfile");
          expect(args).toContain("-NonInteractive");
          expect(args).toContain("-NoLogo");
          expect(options.windowsHide).toBe(true);
          expect(options.shell).toBe(false);
          expect(options.timeout).toBeGreaterThan(0);
          expect(options.timeout).toBeLessThan(timeout);
          const command = args[args.indexOf("-EncodedCommand") + 1];
          if (command === undefined)
            throw new Error("Expected a fixed PowerShell command");
          expect(
            Buffer.from(command, "base64").toString("utf16le"),
          ).not.toContain(path);
          const { input } = options;
          if (typeof input !== "string")
            throw new Error("Expected encoded path data");
          const data = Buffer.from(input, "base64").toString("utf8");
          expect(data).toContain(JSON.stringify(path));
          return result;
        },
      });
      expect(protector.protectPath(path, "file"), reason).toBe(expected);
      expect(called).toBe(true);
    }
    expect(readFileSync(path, "utf8")).toBe(fileText);
  },
  timeout,
);

test(
  "K11 (macOS): removes ACLs from new objects and verifies them before use",
  async () => {
    const cleared = new Set<string>();
    const parent = temp();
    const dir = join(parent, "private-dir");
    const file = join(dir, "private-file");
    const mac = createPathProtection({
      platform: "darwin",
      lstat: fakeMacStat,
      geteuid: () => 123,
      now: () => 100,
      execute(exe, args, options) {
        expect(options.shell).toBe(false);
        const path = args[1];
        if (path === undefined) throw new Error("Expected path argument");
        if (exe === "/bin/chmod") {
          expect(args).toEqual(["-N", path]);
          expect(cleared.has(path)).toBe(false);
          cleared.add(path);
          return { status: 0, stdout: "", stderr: "" };
        }
        expect(exe).toBe("/bin/ls");
        expect(args).toEqual(["-lde", path]);
        const header = lstatSync(path).isDirectory()
          ? noMacAcl
          : noMacAcl.replace(/^d/, "-");
        return {
          status: 0,
          stdout: path === parent || cleared.has(path) ? header : macAcl,
          stderr: "",
        };
      },
    });
    await verifyCreation(mac, parent);
    expect(cleared).toEqual(new Set([dir, file]));
  },
  timeout,
);
