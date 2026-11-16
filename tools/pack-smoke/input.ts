import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function packInput(
  input: string | undefined,
  trustedSha256?: string,
  releaseProof?: string,
): string | undefined {
  if (releaseProof !== undefined && releaseProof !== "1")
    throw new Error(
      "pack-smoke: invalid release-proof mode; use 1 or leave unset",
    );
  if (
    (releaseProof === "1" || trustedSha256 !== undefined) &&
    (input === undefined || !/^[a-f0-9]{64}$/.test(trustedSha256 ?? ""))
  )
    throw new Error(
      "pack-smoke: release proof requires an archive and a reviewed CI artifact sha256",
    );
  if (input === undefined) return undefined;
  const tarball = resolve(input);
  const actual = hash("sha256", readFileSync(tarball));
  if (trustedSha256 !== undefined && actual !== trustedSha256)
    throw new Error("pack-smoke: reviewed CI artifact sha256 mismatch");
  const expected = readFileSync(`${tarball}.sha256`, "utf8").split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || expected !== actual)
    throw new Error(`pack-smoke: sha256 mismatch for ${tarball}`);
  console.log(`- input sha256 ${actual}`);
  return tarball;
}
