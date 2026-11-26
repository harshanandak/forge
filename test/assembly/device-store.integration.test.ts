import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { withCliOwnerApproval } from "../fixtures/owner-approval.mjs";

setDefaultTimeout(30_000);

const bin = resolve("dist/bin/forge.js");
const add = [
  "memory",
  "add",
  "--input",
  '{"level":"device","text":"Private note"}',
];
const search = ["memory", "search", "--input", '{"query":"private"}'];
const posix = process.platform !== "win32";
const canChangeOwner =
  process.platform === "linux" &&
  (process.geteuid?.() === 0 ||
    process.env.GITHUB_ACTIONS === "true" ||
    spawnSync("sudo", ["-n", "true"], { timeout: 10_000 }).status === 0);

function fixture() {
  const work = mkdtempSync(join(tmpdir(), "forge-device-store-"));
  const root = join(work, "project");
  const device = join(work, "device");
  const records = join(device, "records.sqlite");
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge/config.yaml"),
    "blocks:\n  memory: {}\n  work: {}\n",
  );

  function call(args: string[], deviceRoot = device): ResultEnvelope {
    const reply = spawnSync("node", [bin, ...args], {
      cwd: root,
      env: {
        ...process.env,
        FORGE_DEVICE_ROOT: deviceRoot,
        FORGE_SESSION: "device-store-test",
      },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (reply.error) throw reply.error;
    const result = JSON.parse(reply.stdout) as ResultEnvelope;
    expect(reply.status, reply.stderr).toBe(result.ok ? 0 : 1);
    return result;
  }

  return {
    root,
    device,
    records,
    call,
    initGit: () =>
      execFileSync("git", ["init", "--quiet", root], { timeout: 10_000 }),
    reinit: withCliOwnerApproval((args: string[], _expected: number) =>
      call(args),
    ),
    close: () => rmSync(work, { recursive: true, force: true }),
  };
}

function expectRefused(result: ResultEnvelope, path: string, reason: string) {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retry: "never" },
  });
  if (!result.ok) {
    expect(result.error.message).toContain(reason);
    expect(result.error.message).not.toContain(path);
  }
}

for (const { entry, loose, privateMode } of [
  { entry: "records", loose: 0o644, privateMode: 0o600 },
  { entry: "device", loose: 0o755, privateMode: 0o700 },
] as const)
  test.skipIf(!posix)(
    `opening existing device records tightens the ${entry} mode`,
    () => {
      const f = fixture();
      try {
        expect(f.call(add)).toMatchObject({ ok: true });
        chmodSync(f[entry], loose);
        expect(f.call(search)).toMatchObject({
          ok: true,
          result: { matched: 1 },
        });
        expect(statSync(f[entry]).mode & 0o777).toBe(privateMode);
      } finally {
        f.close();
      }
    },
  );

test.skipIf(!canChangeOwner)(
  "a foreign-owned device record file is refused without changing its mode",
  () => {
    const f = fixture();
    try {
      expect(f.call(add)).toMatchObject({ ok: true });
      chmodSync(f.records, 0o644);
      const owner = process.geteuid?.() === 0 ? "65534" : "0";
      const args = [owner, f.records];
      if (owner === "0")
        execFileSync("sudo", ["-n", "chown", ...args], { timeout: 10_000 });
      else execFileSync("chown", args, { timeout: 10_000 });
      expect(statSync(f.records).uid).toBe(Number(owner));
      expectRefused(f.call(search), f.device, "owned by the current user");
      expect(statSync(f.records).mode & 0o777).toBe(0o644);
    } finally {
      f.close();
    }
  },
);

test("a device root inside a checkout is refused before the records directory is created", () => {
  const f = fixture();
  try {
    f.initGit();
    symlinkSync(f.root, f.device, "junction");
    const nested = join(f.device, "nested", "device");
    expectRefused(f.call(add, nested), f.root, "inside a Git work tree");
    expect(existsSync(join(f.root, "nested"))).toBe(false);
  } finally {
    f.close();
  }
});

test.skipIf(!posix)(
  "a symlinked records.sqlite is refused without changing its target",
  () => {
    const f = fixture();
    try {
      const target = join(f.root, "target.sqlite");
      mkdirSync(f.device, { mode: 0o700 });
      writeFileSync(target, "", { mode: 0o644 });
      symlinkSync(target, f.records);
      expectRefused(f.call(add), f.device, "symbolic link");
      expect(lstatSync(f.records).isSymbolicLink()).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o644);
      expect(readFileSync(target)).toHaveLength(0);
    } finally {
      f.close();
    }
  },
);

test("a fresh device store opens and project stores still work inside a checkout", () => {
  const f = fixture();
  try {
    f.initGit();
    expect(f.call(add)).toMatchObject({ ok: true });
    expect(existsSync(f.records)).toBe(true);
    if (posix) {
      expect(statSync(f.device).mode & 0o777).toBe(0o700);
      expect(statSync(f.records).mode & 0o777).toBe(0o600);
    }
    expect(f.reinit(["store", "reinit"])).toMatchObject({ ok: true });
    expect(existsSync(join(f.root, ".forge", "state.sqlite"))).toBe(true);
  } finally {
    f.close();
  }
});
