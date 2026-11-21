// [integration] A repacked archive retains build metadata and receives a replacement sidecar.
import { expect, test } from "bun:test";
import { hash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packInput } from "../../../tools/pack-smoke/input.ts";

test("the independent CI pin rejects repacked bytes even when identity and sidecar agree", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pinned-artifact-"));
  const dist = join(root, "package", "dist");
  const archive = join(root, "candidate.tgz");
  const identity = JSON.stringify({
    version: "0.0.11",
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
    for (const mode of ["replaced archive", "corrupted stage"]) {
      const installMarker = join(root, "npm-install");
      const corruptionMarker = join(root, "stage-corrupted");
      const preload = join(root, "observe.mjs");
      const staged = mode === "corrupted stage";
      const pin = staged ? repack() : trusted;
      writeFileSync(
        preload,
        `import fs from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        if (process.argv.some(arg => /npm-cli[.]js$/.test(arg)) && process.argv.includes('install'))
          fs.writeFileSync(${JSON.stringify(installMarker)}, 'npm install started');
        if (${staged}) {
          const copy = fs.copyFileSync;
          fs.copyFileSync = function(from, to, ...args) {
            copy(from, to, ...args);
            if (String(to).endsWith('reviewed-candidate.tgz')) {
              fs.appendFileSync(to, 'corrupted after staging');
              fs.writeFileSync(${JSON.stringify(corruptionMarker)}, 'corrupted');
            }
          };
          syncBuiltinESMExports();
        }`,
      );
      const node = Bun.which("node");
      if (!node) throw new Error("runner acceptance requires Node");
      const out = spawnSync(
        node,
        [resolve(import.meta.dirname, "../../../tools/pack-smoke/run.ts")],
        {
          env: {
            ...process.env,
            FORGE_PACK_INPUT: archive,
            FORGE_PACK_EXPECTED_SHA256: pin,
            NODE_OPTIONS:
              `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
          },
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      expect(out.error, mode).toBeUndefined();
      expect(out.status, mode).not.toBe(0);
      expect(out.stderr, mode).toContain(
        "reviewed CI artifact sha256 mismatch",
      );
      expect(existsSync(installMarker), mode).toBe(false);
      if (staged)
        expect(readFileSync(corruptionMarker, "utf8")).toBe("corrupted");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
