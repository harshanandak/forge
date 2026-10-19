import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

test("every shipped first-party operation declares a bounded deadline", () => {
  const root = resolve(import.meta.dirname, "../../../src/blocks");
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? visit(path)
        : entry.name === "forge.block.json"
          ? [path]
          : [];
    });
  const manifests = visit(root);
  expect(manifests.length).toBeGreaterThan(0);
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      operations: Record<string, { timeoutMs?: number }>;
    };
    for (const [name, operation] of Object.entries(manifest.operations)) {
      expect(
        Number.isSafeInteger(operation.timeoutMs),
        `${path}: ${name}`,
      ).toBe(true);
      expect(operation.timeoutMs!, name).toBeGreaterThanOrEqual(1);
      expect(operation.timeoutMs!, name).toBeLessThanOrEqual(2147483647);
    }
  }
}, 30000);
