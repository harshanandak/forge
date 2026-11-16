// [integration] A repacked archive retains build metadata and receives a replacement sidecar.
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
import { join } from "node:path";
import { packInput } from "../../../tools/pack-smoke/input.ts";

test("the independent CI pin rejects repacked bytes even when identity and sidecar agree", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pinned-artifact-"));
  const dist = join(root, "package", "dist");
  const archive = join(root, "candidate.tgz");
  const identity = JSON.stringify({
    version: "0.1.0-beta.9",
    commit: "a".repeat(40),
    dirty: false,
  });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "build.json"), identity);
  const tar = (args: string[]) => {
    const out = Bun.spawnSync(["tar", ...args], { cwd: root });
    if (out.exitCode !== 0)
      throw new Error(`tar failed: ${out.stderr.toString()}`);
    return out.stdout.toString();
  };
  const repack = () => {
    tar(["-czf", "candidate.tgz", "package"]);
    const digest = hash("sha256", readFileSync(archive));
    writeFileSync(`${archive}.sha256`, `${digest}  candidate.tgz\n`);
    expect(tar(["-xOf", "candidate.tgz", "package/dist/build.json"])).toBe(
      identity,
    );
    return digest;
  };
  try {
    writeFileSync(join(dist, "forge.js"), "reviewed code");
    const trusted = repack();
    expect(packInput(archive, trusted)).toBe(archive);
    writeFileSync(
      join(dist, "forge.js"),
      "changed code with unchanged identity",
    );
    expect(repack()).not.toBe(trusted);
    expect(packInput(archive)).toBe(archive);
    expect(() => packInput(archive, trusted)).toThrow("reviewed CI artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
