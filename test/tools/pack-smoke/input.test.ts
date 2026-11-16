import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packInput } from "../../../tools/pack-smoke/input.ts";

test("an unset pack input selects the local build and pack fallback", () => {
  expect(packInput(undefined)).toBeUndefined();
  expect(() => packInput(undefined, "a".repeat(64))).toThrow();
}, 1000);

test("pack input accepts only bytes matching its SHA-256 sidecar", () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-pack-input-"));
  try {
    const tarball = join(folder, "forge-workflow.tgz");
    const bytes = "one immutable artifact";
    writeFileSync(tarball, bytes);
    expect(() => packInput(tarball)).toThrow();
    writeFileSync(`${tarball}.sha256`, "not a checksum\n");
    expect(() => packInput(tarball)).toThrow("sha256 mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(`${tarball}.sha256`, `${digest}  forge-workflow.tgz\n`);
    expect(packInput(tarball)).toBe(tarball);
    expect(packInput(tarball, digest)).toBe(tarball);
    for (const pin of ["", "invalid", "A".repeat(64), "f".repeat(64)])
      expect(() => packInput(tarball, pin)).toThrow();
    writeFileSync(tarball, "changed artifact");
    expect(() => packInput(tarball)).toThrow("sha256 mismatch");
    expect(() => packInput("")).toThrow();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 1000);
