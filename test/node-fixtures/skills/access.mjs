import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../../dist/src/assembly/index.js";
import { runCli } from "../../../dist/src/surface/cli.js";
import { validateResultEnvelope } from "../../../dist/src/generated/validators.js";
import { removeEmptyParents } from "../../../dist/src/adapters/fs/index.js";

const root = fs.realpathSync.native(process.argv[2]);
const operation = process.argv[3];
if (operation === "cleanup") {
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    fs.mkdirSync(join(root, "cleanup/deep"), { recursive: true });
    const real = fs.rmdirSync;
    fs.rmdirSync = function (path, ...args) {
      if (String(path) === join(root, "cleanup"))
        throw Object.assign(new Error(`injected ${code}`), { code });
      return real.call(fs, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => removeEmptyParents(root, "cleanup/deep/old.txt", "cleanup"),
        (error) =>
          error instanceof Error &&
          "relativePath" in error &&
          error.relativePath === "cleanup",
      );
      assert.equal(fs.existsSync(join(root, "cleanup/deep")), false);
      console.log(`cleanup ${code}: reported actual ancestor`);
    } finally {
      fs.rmdirSync = real;
      syncBuiltinESMExports();
    }
  }
  process.exit(0);
}
const assembly = await createAssembly({
  root,
  deviceRoot: join(root, "device"),
});
const cli = (check = false) =>
  runCli(
    assembly.catalog,
    ["skills", "sync", ...(check ? ["--check"] : [])],
    localCall(assembly),
  );
const target = join(root, ".agents/skills/forge-loop/SKILL.md");
const healthy = join(root, ".agents/skills/forge-intake/SKILL.md");
const same = (path) =>
  resolve(String(path)).toLowerCase() === target.toLowerCase();
const real = {
  lstatSync: fs.lstatSync,
  fstatSync: fs.fstatSync,
  openSync: fs.openSync,
  closeSync: fs.closeSync,
};
try {
  assert.equal((await cli()).exitCode, 0);
  const original = fs.readFileSync(target);
  const healthyOriginal = fs.readFileSync(healthy, "utf8");
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    const descriptors = new Set();
    let faults = 0;
    const fail = () => {
      faults++;
      throw Object.assign(new Error(`injected ${operation} ${code}`), { code });
    };
    fs.lstatSync = function (path, ...args) {
      if (operation === "lstat" && same(path)) fail();
      return real.lstatSync.call(fs, path, ...args);
    };
    fs.openSync = function (path, ...args) {
      const fd = real.openSync.call(fs, path, ...args);
      if (same(path)) descriptors.add(fd);
      return fd;
    };
    fs.fstatSync = function (fd, ...args) {
      if (operation === "stat" && descriptors.has(fd)) fail();
      return real.fstatSync.call(fs, fd, ...args);
    };
    fs.closeSync = function (fd) {
      descriptors.delete(fd);
      return real.closeSync.call(fs, fd);
    };
    syncBuiltinESMExports();
    try {
      const checked = await cli(true);
      fs.appendFileSync(healthy, "\ndrift\n");
      const synced = await cli();
      const evidence = JSON.stringify({
        code,
        operation,
        faults,
        check: checked.exitCode,
        sync: synced.exitCode,
        warnings: synced.envelope.warnings,
      });
      assert.equal(checked.exitCode, 1, evidence);
      assert.equal(synced.exitCode, 0, evidence);
      for (const response of [checked, synced]) {
        assert.equal(
          validateResultEnvelope(response.envelope).ok,
          true,
          evidence,
        );
        assert(
          response.envelope.warnings.some(
            (warning) => warning.code === "SKILLS_READ_FAILED",
          ),
          evidence,
        );
      }
      assert(faults > 0);
      assert.deepEqual(fs.readFileSync(target), original);
      assert.equal(fs.readFileSync(healthy, "utf8"), healthyOriginal);
      console.log(
        `${operation} ${code}: reported; other skill repaired; failed skill preserved`,
      );
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
  }
} finally {
  await assembly.close();
}
