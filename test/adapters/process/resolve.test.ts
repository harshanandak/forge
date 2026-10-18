import { expect, test } from "bun:test";
import {
  type FileProbe,
  resolveExecutable,
} from "../../../src/adapters/process/resolve.ts";

/** A probe over a fixed set of files; `executable` lists those with the POSIX execute bit. */
function probeOf(files: string[], executable: string[] = files): FileProbe {
  return {
    isFile: (path) => files.includes(path),
    isExecutable: (path) => executable.includes(path),
  };
}

const windowsEnv = {
  Path: "C:\\Program Files\\nodejs;C:\\tools",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
};

test("windows: the extensionless shim next to npm.cmd is never picked (old issue 9997d516)", () => {
  // where.exe used to list `npm` first; starting that bash script failed with ENOENT.
  const probe = probeOf([
    "C:\\Program Files\\nodejs\\npm",
    "C:\\Program Files\\nodejs\\npm.cmd",
  ]);
  expect(resolveExecutable("npm", windowsEnv, "win32", probe)).toEqual({
    kind: "resolved",
    path: "C:\\Program Files\\nodejs\\npm.cmd",
  });
}, 30_000);

test("windows: an extensionless file alone is not runnable", () => {
  const probe = probeOf(["C:\\tools\\tool"]);
  const found = resolveExecutable("tool", windowsEnv, "win32", probe);
  expect(found.kind).toBe("unavailable");
}, 30_000);

test("windows: PATHEXT order decides between .exe and .cmd in one folder", () => {
  const probe = probeOf(["C:\\tools\\tool.cmd", "C:\\tools\\tool.exe"]);
  expect(resolveExecutable("tool", windowsEnv, "win32", probe)).toEqual({
    kind: "resolved",
    path: "C:\\tools\\tool.exe",
  });
  const cmdFirst = { ...windowsEnv, PATHEXT: ".CMD;.EXE" };
  expect(resolveExecutable("tool", cmdFirst, "win32", probe)).toEqual({
    kind: "resolved",
    path: "C:\\tools\\tool.cmd",
  });
}, 30_000);

test("windows: extensions CreateProcess cannot start are skipped", () => {
  const probe = probeOf(["C:\\tools\\tool.vbs", "C:\\tools\\tool.js"]);
  expect(resolveExecutable("tool", windowsEnv, "win32", probe).kind).toBe(
    "unavailable",
  );
}, 30_000);

test("windows: PATH is found whatever its case, and a missing PATHEXT uses the default list", () => {
  const probe = probeOf(["C:\\tools\\git.exe"]);
  for (const name of ["PATH", "Path", "path"]) {
    expect(
      resolveExecutable("git", { [name]: "C:\\tools" }, "win32", probe),
    ).toEqual({ kind: "resolved", path: "C:\\tools\\git.exe" });
  }
}, 30_000);

test("windows: a name that already has a runnable extension is tried as written", () => {
  const probe = probeOf(["C:\\tools\\npm.cmd"]);
  expect(resolveExecutable("npm.cmd", windowsEnv, "win32", probe)).toEqual({
    kind: "resolved",
    path: "C:\\tools\\npm.cmd",
  });
}, 30_000);

test("windows: quoted PATH entries and empty entries are tolerated", () => {
  const probe = probeOf(["C:\\Program Files\\tool\\t.exe"]);
  const env = { PATH: ';"C:\\Program Files\\tool";' };
  expect(resolveExecutable("t", env, "win32", probe)).toEqual({
    kind: "resolved",
    path: "C:\\Program Files\\tool\\t.exe",
  });
}, 30_000);

test("the working directory is never searched", () => {
  const probe = probeOf(["t.exe", "./t", "t"]);
  expect(resolveExecutable("t", { PATH: "" }, "win32", probe).kind).toBe(
    "unavailable",
  );
  expect(resolveExecutable("t", { PATH: "" }, "linux", probe).kind).toBe(
    "unavailable",
  );
}, 30_000);

test("posix: only files with the execute bit match, first PATH entry first", () => {
  const probe = probeOf(
    ["/a/tool", "/b/tool"],
    ["/b/tool"], // /a/tool is not executable
  );
  expect(resolveExecutable("tool", { PATH: "/a:/b" }, "linux", probe)).toEqual({
    kind: "resolved",
    path: "/b/tool",
  });
}, 30_000);

test("an absolute path resolves directly; a relative path with a directory is refused", () => {
  const probe = probeOf(["/opt/x/tool"]);
  expect(resolveExecutable("/opt/x/tool", {}, "linux", probe)).toEqual({
    kind: "resolved",
    path: "/opt/x/tool",
  });
  const relative = resolveExecutable("./tool", {}, "linux", probe);
  expect(relative.kind).toBe("unavailable");
  const winProbe = probeOf(["C:\\x\\tool.exe"]);
  expect(resolveExecutable("C:\\x\\tool", {}, "win32", winProbe)).toEqual({
    kind: "resolved",
    path: "C:\\x\\tool.exe",
  });
  for (const name of ["x\\tool", "x/tool", ".\\tool"]) {
    expect(resolveExecutable(name, {}, "win32", winProbe)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("relative path") as string,
    });
  }
}, 30_000);

test("a missing tool is Unavailable with a reason and a remedy, never a throw", () => {
  const found = resolveExecutable(
    "nope",
    { PATH: "/bin" },
    "linux",
    probeOf([]),
  );
  expect(found).toEqual({
    kind: "unavailable",
    reason: '"nope" was not found on PATH',
    remedy: "Install nope or add the folder that holds it to PATH.",
  });
}, 30_000);

test("empty, NUL and wildcard names are refused", () => {
  for (const name of ["", "a\0b"]) {
    expect(
      resolveExecutable(name, { PATH: "/bin" }, "linux", probeOf([])).kind,
    ).toBe("unavailable");
  }
  expect(
    resolveExecutable("a*", { PATH: "C:\\x" }, "win32", probeOf([])).kind,
  ).toBe("unavailable");
}, 30_000);
