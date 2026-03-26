import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const toolchainPath = resolve(import.meta.dirname, "../docs/TOOLCHAIN.md");

describe("TOOLCHAIN.md bd version documentation", () => {
  test("contains bd or beads reference in a version context", () => {
    const content = readFileSync(toolchainPath, "utf8");
    // Must mention bd/beads in the context of a minimum version
    const hasBdVersionRef =
      /\bbd\b.*version|beads.*version|version.*\bbd\b|version.*beads/i.test(
        content,
      );
    expect(hasBdVersionRef).toBe(true);
  });

  test("contains a version number pattern for bd", () => {
    const content = readFileSync(toolchainPath, "utf8");
    // Must contain a version like 0.49 or v0.
    const hasVersionNumber = /0\.49|v0\./i.test(content);
    expect(hasVersionNumber).toBe(true);
  });
});
