import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfigFiles } from "../../../src/adapters/fs/index.ts";

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test.each([false, true])(
  "config refuses a parent swapped after validation (same leaf identity: %s)",
  (sameLeaf) => {
    const fixture = mkdtempSync(join(tmpdir(), "forge-config-read-"));
    roots.push(fixture);
    const root = join(fixture, "project");
    const parent = join(root, ".forge");
    const outside = join(fixture, "outside");
    mkdirSync(parent, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(parent, "config.yaml"), "inside!");
    if (sameLeaf)
      linkSync(join(parent, "config.yaml"), join(outside, "config.yaml"));
    else writeFileSync(join(outside, "config.yaml"), "outside");

    let swapped = false;
    const files = nodeConfigFiles(root, {
      beforeOpen() {
        renameSync(parent, join(root, "saved"));
        symlinkSync(outside, parent, "junction");
        swapped = true;
      },
    });
    let returned: Uint8Array | undefined;
    expect(() => {
      returned = files.read(".forge/config.yaml");
    }).toThrow(/changed during open/);
    expect(swapped).toBe(true);
    expect(returned).toBeUndefined();
  },
  30_000,
);
