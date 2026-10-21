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

/**
 * A file's DACL as icacls would change it, recording every state it passes through. `fail`
 * makes the named icacls switch fail without changing anything.
 */
function aclFake(
  start: readonly string[],
  fail?: string,
): { readonly port: ProcessPort; readonly states: string[][] } {
  let aces = [...start];
  const states: string[][] = [aces];
  const { port } = fakePort((args) => {
    const op = args[1] ?? "";
    if (op === fail) return { exitCode: 5, stderr: "Access is denied." };
    const named = new Set(args.slice(2).map((name) => name.slice(1)));
    const trustee = (ace: string): string => ace.split(";")[5] ?? "";
    if (op === "/inheritance:r")
      aces = [
        `A;;FA;;;${sid}`,
        ...aces.filter((ace) => !/^A;ID;/.test(ace) && trustee(ace) !== sid),
      ];
    // The parent's defaults: the window Codex flagged, where other users can open the file.
    else if (op === "/reset") aces = ["A;ID;FA;;;BA", "A;ID;FR;;;BU"];
    else if (op === "/remove:g" || op === "/remove:d") {
      const type = op === "/remove:g" ? "A" : "D";
      aces = aces.filter(
        (ace) => ace.split(";")[0] !== type || !named.has(trustee(ace)),
      );
    }
    if (op === "/save")
      writeFileSync(
        args[2] ?? "",
        `store\r\nD:PAI${aces.map((ace) => `(${ace})`).join("")}\r\n`,
        "utf16le",
      );
    else states.push(aces);
    return {};
  });
  return { port, states };
}

/** Trustees other than the current user that some state allows in. */
const othersAllowed = (aces: readonly string[]): string[] =>
  aces.filter((ace) => ace[0] === "A" && !ace.endsWith(sid));

test("leftover explicit entries are removed by trustee, and no state is broader than the last", () =>
  withFile(async (file) => {
    const { port, states } = aclFake([
      "A;;FR;;;WD",
      "D;;FA;;;BU",
      "A;ID;FA;;;BA",
    ]);
    await hardenPrivatePaths([file], port, env, "win32");
    expect(states.at(-1)).toEqual([`A;;FA;;;${sid}`]);
    for (const [index, state] of states.entries())
      for (const allowed of othersAllowed(state))
        expect(othersAllowed(states[index - 1] ?? state)).toContain(allowed);
  }));

test("a failing removal leaves the ACL no broader than before and fails closed", () =>
  withFile(async (file) => {
    const { port, states } = aclFake(
      ["A;;FR;;;WD", "A;ID;FA;;;BA"],
      "/remove:g",
    );
    expect(await failure([file], port)).toMatch(
      /^Private ACL application or verification failed \(icacls\.exe exit 5/,
    );
    expect(othersAllowed(states.at(-1) ?? [])).toEqual(["A;;FR;;;WD"]);
  }));

test("an ACL entry that is neither allow nor deny is refused, not guessed at", () =>
  withFile(async (file) => {
    const { port, states } = aclFake(["OA;;FA;;;WD"]);
    expect(await failure([file], port)).toMatch(/unexpected ACL entry OA/);
    expect(states).toHaveLength(2);
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

for (const [service, alias] of [
  ["S-1-5-19", "LS"],
  ["S-1-5-20", "NS"],
] as const)
  test(`the ${alias} service account reads back under its SDDL alias`, () =>
    withFile(async (file) => {
      const { port } = fakePort((args) => {
        if (args[1] === "/save")
          writeFileSync(
            args[2] ?? "",
            `store\r\nD:PAI(A;;FA;;;${alias})\r\n`,
            "utf16le",
          );
        return {};
      }, service);
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
