import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function packInput(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const tarball = resolve(input);
  const expected = readFileSync(`${tarball}.sha256`, "utf8").split(/\s+/)[0];
  const actual = hash("sha256", readFileSync(tarball));
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || expected !== actual)
    throw new Error(`pack-smoke: sha256 mismatch for ${tarball}`);
  console.log(`- input sha256 ${actual}`);
  return tarball;
}
