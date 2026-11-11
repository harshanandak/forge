import { expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createDeviceFiles } from "../../../src/adapters/fs/device-identity.ts";
import { windowsPrivateFiles } from "../../../src/adapters/process/windows-acl.ts";
import { privateFileGuard } from "../../../src/adapters/store-sqlite/private-files.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";

setDefaultTimeout(30_000);

const NAME = "credentials.json";
const windows = process.platform === "win32";
const posix = !windows;

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "forge-cloud-files-"));
  return {
    home,
    cloud: join(home, ".forge", "cloud"),
    file: join(home, ".forge", "cloud", NAME),
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** The host's own security hook: the native DACL guard on Windows, the mode checks elsewhere. */
function host() {
  return windows ? privateFileGuard(windowsPrivateFiles()) : undefined;
}

/** A security hook that lets a test decide which private-file checks fail. */
function hook(fails: (path: string) => boolean) {
  return {
    directory() {},
    file(path: string) {
      if (fails(path)) throw new Error(`Private ACL refused: ${path}`);
    },
  };
}

function integrity(run: () => unknown): ForgeFailure {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    const failure = error as ForgeFailure;
    expect(failure.error.code).toBe("ACCOUNT_INTEGRITY");
    return failure;
  }
  throw new Error("expected an ACCOUNT_INTEGRITY refusal");
}

/** Pretend to be another user for the duration of one call. */
function asAnotherUser<T>(run: () => T): T {
  const original = process.getuid;
  Object.defineProperty(process, "getuid", {
    value: () => (original?.call(process) ?? 0) + 1,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "getuid", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

test("cloud files live under .forge/cloud and accounts stays the default folder", () => {
  const s = sandbox();
  try {
    const cloud = createDeviceFiles(s.home, host(), "cloud");
    cloud.write(NAME, "a");
    expect(existsSync(s.file)).toBe(true);
    expect(cloud.read(NAME)).toBe("a");
    const accounts = createDeviceFiles(s.home, host());
    accounts.write("record", "b");
    expect(
      readFileSync(join(s.home, ".forge", "accounts", "record"), "utf8"),
    ).toBe("b");
    expect(existsSync(join(s.cloud, "record"))).toBe(false);
    expect(accounts.read(NAME)).toBeUndefined();
  } finally {
    s.close();
  }
}, 20_000);

test.skipIf(!posix)(
  "cloud directory and file are created private",
  () => {
    const s = sandbox();
    try {
      createDeviceFiles(s.home, undefined, "cloud").write(NAME, "a");
      expect(existsSync(s.file)).toBe(true);
      expect(statSync(s.cloud).mode & 0o777).toBe(0o700);
      expect(statSync(s.file).mode & 0o777).toBe(0o600);
    } finally {
      s.close();
    }
  },
  20_000,
);

test.skipIf(!posix)(
  "a cloud file or folder owned by another user is refused before reading or replacing",
  () => {
    const s = sandbox();
    try {
      const files = createDeviceFiles(s.home, undefined, "cloud");
      files.write(NAME, "a");
      expect(existsSync(s.file)).toBe(true);
      asAnotherUser(() => {
        integrity(() => files.read(NAME));
        integrity(() => files.write(NAME, "b"));
      });
      expect(readFileSync(s.file, "utf8")).toBe("a");
      expect(files.read(NAME)).toBe("a");
    } finally {
      s.close();
    }
  },
  20_000,
);

test.skipIf(!posix)(
  "a broader file or folder mode is refused, and a replace leaves the bytes alone",
  () => {
    const s = sandbox();
    try {
      const files = createDeviceFiles(s.home, undefined, "cloud");
      files.write(NAME, "a");
      expect(existsSync(s.file)).toBe(true);
      chmodSync(s.file, 0o644);
      integrity(() => files.read(NAME));
      integrity(() => files.write(NAME, "b"));
      expect(readFileSync(s.file, "utf8")).toBe("a");
      chmodSync(s.file, 0o600);
      chmodSync(s.cloud, 0o755);
      integrity(() => files.read(NAME));
      integrity(() => files.write(NAME, "b"));
      chmodSync(s.cloud, 0o700);
      expect(readFileSync(s.file, "utf8")).toBe("a");
    } finally {
      s.close();
    }
  },
  20_000,
);

test("an extra hard link is refused on read and on replace", () => {
  const s = sandbox();
  try {
    const files = createDeviceFiles(s.home, host(), "cloud");
    files.write(NAME, "a");
    expect(existsSync(s.file)).toBe(true);
    linkSync(s.file, join(s.cloud, "copy"));
    integrity(() => files.read(NAME));
    integrity(() => files.write(NAME, "b"));
    expect(readFileSync(s.file, "utf8")).toBe("a");
  } finally {
    s.close();
  }
}, 20_000);

test.skipIf(!posix)(
  "a symlink or a directory in place of the file is refused and never replaced",
  () => {
    const s = sandbox();
    try {
      const files = createDeviceFiles(s.home, undefined, "cloud");
      files.write("other", "x");
      expect(existsSync(join(s.cloud, "other"))).toBe(true);
      symlinkSync(join(s.cloud, "other"), s.file);
      integrity(() => files.read(NAME));
      integrity(() => files.write(NAME, "b"));
      expect(readFileSync(join(s.cloud, "other"), "utf8")).toBe("x");
      rmSync(s.file);
      mkdirSync(s.file, { mode: 0o700 });
      integrity(() => files.write(NAME, "b"));
    } finally {
      s.close();
    }
  },
  20_000,
);

test("a failed check on the staged file stops the replace and leaves no temporary file", () => {
  const s = sandbox();
  try {
    let staged = false;
    const files = createDeviceFiles(
      s.home,
      hook((path) => staged && basename(path) !== NAME),
      "cloud",
    );
    files.write(NAME, "a");
    staged = true;
    integrity(() => files.write(NAME, "b"));
    expect(readFileSync(s.file, "utf8")).toBe("a");
    expect(readdirSync(s.cloud)).toEqual([NAME]);
  } finally {
    s.close();
  }
}, 20_000);

test("a native security failure on the existing file is one integrity refusal that names no path", () => {
  const s = sandbox();
  try {
    let broken = false;
    const files = createDeviceFiles(
      s.home,
      hook((path) => broken && basename(path) === NAME),
      "cloud",
    );
    files.write(NAME, "a");
    broken = true;
    const read = integrity(() => files.read(NAME));
    const write = integrity(() => files.write(NAME, "b"));
    for (const failure of [read, write])
      expect(failure.error.message).not.toContain(s.home);
    broken = false;
    expect(readFileSync(s.file, "utf8")).toBe("a");
    expect(files.read(NAME)).toBe("a");
  } finally {
    s.close();
  }
}, 20_000);

test("a forced replace skips the check on the old file but still checks the staged one", () => {
  const s = sandbox();
  try {
    let oldFileBroken = false;
    let staged = false;
    const files = createDeviceFiles(
      s.home,
      hook(
        (path) =>
          (oldFileBroken && basename(path) === NAME) ||
          (staged && basename(path) !== NAME),
      ),
      "cloud",
    );
    files.write(NAME, "a");
    oldFileBroken = true;
    integrity(() => files.write(NAME, "b"));
    files.write(NAME, "c", { force: true });
    oldFileBroken = false;
    expect(files.read(NAME)).toBe("c");
    staged = true;
    integrity(() => files.write(NAME, "d", { force: true }));
    staged = false;
    expect(files.read(NAME)).toBe("c");
  } finally {
    s.close();
  }
}, 20_000);

test("account files keep their existing behaviour: no owner check and a replace over a broad file", () => {
  const s = sandbox();
  try {
    const files = createDeviceFiles(s.home, host());
    files.write("record", "a");
    const path = join(s.home, ".forge", "accounts", "record");
    if (posix) chmodSync(path, 0o644);
    files.write("record", "b");
    expect(files.read("record")).toBe("b");
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(asAnotherUser(() => files.read("record"))).toBe("b");
    }
    expect(existsSync(s.cloud)).toBe(false);
  } finally {
    s.close();
  }
}, 20_000);

test.skipIf(!windows)(
  "on Windows the credential file's real DACL is verified, and a broadened one is refused",
  () => {
    const s = sandbox();
    try {
      const native = windowsPrivateFiles();
      const files = createDeviceFiles(
        s.home,
        privateFileGuard(native),
        "cloud",
      );
      files.write(NAME, "a");
      expect(files.read(NAME)).toBe("a");
      expect(native.read(s.file)).not.toContain(";;;WD)");
      native.protect(s.file, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
      const broadened = native.read(s.file);
      expect(broadened).toContain(";;;WD)");
      integrity(() => files.read(NAME));
      integrity(() => files.write(NAME, "b"));
      expect(native.read(s.file)).toBe(broadened);
      expect(readFileSync(s.file, "utf8")).toBe("a");
    } finally {
      s.close();
    }
  },
  30_000,
);
