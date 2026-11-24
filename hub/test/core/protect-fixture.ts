import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PathProtection } from "../../src/core/protect.ts";

export const timeout = 30_000;
export const fileText = "stored data";

export function protectionFixture() {
  const dirs: string[] = [];
  return {
    temp(this: void) {
      const dir = mkdtempSync(join(tmpdir(), "forge-hub-protect-"));
      dirs.push(dir);
      return dir;
    },
    cleanup(this: void) {
      for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function verifyCreation(
  protector: PathProtection,
  base: string,
): Promise<void> {
  const dir = join(base, "private-dir");
  const path = join(dir, "private-file");
  expect(await protector.createPrivateDirectory(dir)).toBe(true);
  expect(protector.protectPath(dir, "dir")).toBe(true);
  const file = await protector.createPrivateFile(path);
  if (file === null) throw new Error("Expected a private file");
  try {
    expect(protector.protectPath(path, "file")).toBe(true);
    await file.writeFile(fileText);
    expect(await protector.createPrivateDirectory(dir)).toBe(false);
    expect(await protector.createPrivateFile(path)).toBeNull();
    expect(protector.protectPath(dir, "dir")).toBe(true);
    expect(protector.protectPath(path, "file")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(fileText);
  } finally {
    await file.close();
  }
}
