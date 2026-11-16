// [integration] Repack a real archive while preserving build metadata and replacing its sidecar.
import { expect, test } from "bun:test";
import { hash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packInput } from "../../../tools/pack-smoke/input.ts";

test("release proof rejects repacked bytes with preserved identity and a recalculated sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pinned-artifact-"));
  const dist = join(root, "package", "dist");
  const archive = join(root, "candidate.tgz");
  const identity = JSON.stringify({
    version: "0.0.1",
    commit: "a".repeat(40),
    dirty: false,
  });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "build.json"), identity);
  const tar = (args: string[]) => {
    const out = Bun.spawnSync(["tar", ...args]);
    expect(out.exitCode).toBe(0);
    return out.stdout.toString();
  };
  const repack = () => {
    tar(["-czf", archive, "-C", root, "package"]);
    const digest = hash("sha256", readFileSync(archive));
    writeFileSync(`${archive}.sha256`, `${digest}  candidate.tgz\n`);
    expect(tar(["-xOf", archive, "package/dist/build.json"])).toBe(identity);
    return digest;
  };
  try {
    writeFileSync(join(dist, "forge.js"), "reviewed code");
    const trusted = repack();
    expect(packInput(archive, trusted, "1")).toBe(archive);
    writeFileSync(
      join(dist, "forge.js"),
      "modified code with identical build identity",
    );
    expect(repack()).not.toBe(trusted);
    expect(packInput(archive)).toBe(archive);
    for (const [input, pin, mode, error] of [
      [archive, trusted, "1", "reviewed CI artifact"],
      [archive, undefined, "1", "reviewed CI artifact"],
      [undefined, trusted, "1", "reviewed CI artifact"],
      [undefined, undefined, "1", "reviewed CI artifact"],
      [archive, trusted, "0", "invalid release-proof mode"],
    ] as const) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FORGE_RELEASE_PROOF: mode,
        FORGE_PACK_INPUT: input,
        FORGE_PACK_EXPECTED_SHA256: pin,
      };
      if (input === undefined) delete env.FORGE_PACK_INPUT;
      if (pin === undefined) delete env.FORGE_PACK_EXPECTED_SHA256;
      const refused = Bun.spawnSync(
        [
          "node",
          resolve(import.meta.dirname, "../../../tools/pack-smoke/run.ts"),
        ],
        { env, timeout: 10_000 },
      );
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr.toString()).toContain(error);
      expect(refused.stdout.toString()).not.toContain("npm");
      expect(refused.stdout.toString()).not.toContain("run build");
    }
    expect(() => packInput(archive, trusted, "1")).toThrow(
      "reviewed CI artifact",
    );
    expect(() => packInput(archive, trusted)).toThrow("reviewed CI artifact");
    for (const pin of [undefined, "", "not-a-digest", "f".repeat(64)])
      expect(() => packInput(archive, pin, "1")).toThrow();
    for (const mode of ["", "0", "false", "invalid"])
      expect(() => packInput(archive, trusted, mode)).toThrow();
    expect(() => packInput(undefined, trusted, "1")).toThrow();
    expect(() => packInput(undefined, undefined, "1")).toThrow();
    expect(() => packInput(undefined, trusted)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
