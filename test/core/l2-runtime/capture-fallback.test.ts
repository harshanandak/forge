import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileCapture } from "../../../src/adapters/node-runtime/capture.ts";

/** What musl without /proc does: the native resolver fails for a path that exists. */
function unusableNative(): string {
  throw Object.assign(
    new Error("ENOENT: no such file or directory, realpath"),
    {
      code: "ENOENT",
    },
  );
}

test("capture still reads files when the native path resolver is unusable", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-fallback-"));
  try {
    mkdirSync(join(root, "block", "nested"), { recursive: true });
    writeFileSync(join(root, "block", "entry"), "inside");
    writeFileSync(join(root, "block", "nested", "deep"), "deeper");
    let nativeCalls = 0;
    const capture = createNodeFileCapture(undefined, () => {
      nativeCalls += 1;
      return unusableNative();
    });
    const opened = capture.open(join(root, "block")).value;
    assert.equal(Buffer.from(opened.read("entry", 100)).toString(), "inside");
    assert.equal(
      Buffer.from(opened.read("nested/deep", 100)).toString(),
      "deeper",
    );
    // The first root decided: later files and later opens do not try the native resolver again.
    capture.open(join(root, "block")).value.read("entry", 100);
    assert.equal(nativeCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

test("capture still refuses paths outside its root when the native path resolver is unusable", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-fallback-escape-"));
  try {
    mkdirSync(join(root, "block"));
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "block", "entry"), "inside");
    writeFileSync(join(root, "outside", "entry"), "outside");
    symlinkSync(
      join(root, "outside"),
      join(root, "block", "linked"),
      "junction",
    );
    const opened = createNodeFileCapture(undefined, unusableNative).open(
      join(root, "block"),
    ).value;
    assert.throws(() => opened.read("../outside/entry", 100), /INPUT_INVALID/);
    assert.throws(() => opened.read("linked/entry", 100), /INPUT_INVALID/);
    assert.equal(Buffer.from(opened.read("entry", 100)).toString(), "inside");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

test("capture reports a missing root with the resolver's own error when the native path resolver is unusable", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-fallback-missing-"));
  try {
    const capture = createNodeFileCapture(undefined, unusableNative);
    assert.throws(() => capture.open(join(root, "absent")), /ENOENT/);
    // A root that is simply missing decides nothing: a real root opens afterwards.
    mkdirSync(join(root, "block"));
    writeFileSync(join(root, "block", "entry"), "inside");
    assert.equal(
      Buffer.from(
        capture.open(join(root, "block")).value.read("entry", 100),
      ).toString(),
      "inside",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);
