import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function packInput(
  input: string | undefined,
  trustedSha256?: string,
): string | undefined {
  if (
    trustedSha256 !== undefined &&
    (input === undefined || !/^[a-f0-9]{64}$/.test(trustedSha256))
  )
    throw new Error(
      "pack-smoke: a reviewed CI artifact sha256 requires an archive and a valid digest",
    );
  if (input === undefined) return undefined;
  const tarball = resolve(input);
  const expected = readFileSync(`${tarball}.sha256`, "utf8").split(/\s+/)[0];
  const actual = hash("sha256", readFileSync(tarball));
  if (trustedSha256 !== undefined && actual !== trustedSha256)
    throw new Error("pack-smoke: reviewed CI artifact sha256 mismatch");
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || expected !== actual)
    throw new Error(`pack-smoke: sha256 mismatch for ${tarball}`);
  console.log(`- input sha256 ${actual}`);
  return tarball;
}
