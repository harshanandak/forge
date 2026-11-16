// [integration] Fault the real installed CLI's identity output; run the unmodified smoke runner.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packedConsumer } from "../../../integration/packed-consumer.ts";

for (const [field, value] of [
  ["version", "wrong-version"],
  ["commit", "f".repeat(40)],
  ["dirty", true],
] as const) {
  test(`installed identity rejects a substituted ${field}`, () => {
    const consumer = packedConsumer();
    const work = mkdtempSync(join(tmpdir(), "forge-installed-identity-"));
    try {
      const packed = process.env.FORGE_PACKED_TARBALL;
      if (!packed) throw new Error("packed smoke must provide its archive");
      const archive = join(work, "candidate.tgz");
      copyFileSync(packed, archive);
      const digest =
        process.env.FORGE_PACK_EXPECTED_SHA256 ??
        hash("sha256", readFileSync(archive));
      writeFileSync(`${archive}.sha256`, `${digest}  candidate.tgz\n`);
      const build = JSON.parse(
        readFileSync(
          join(consumer, "node_modules/forge-workflow/dist/build.json"),
          "utf8",
        ),
      ) as { version: string; commit: string };
      const root = resolve(import.meta.dirname, "../../../..");
      const author = join(work, "author");
      mkdirSync(join(author, "tools"), { recursive: true });
      cpSync(join(root, "tools/pack-smoke"), join(author, "tools/pack-smoke"), {
        recursive: true,
      });
      cpSync(join(root, "package.json"), join(author, "package.json"));
      // A real, bounded fixture suite avoids recursively dispatching this acceptance file.
      mkdirSync(join(author, "test/marker"), { recursive: true });
      writeFileSync(
        join(author, "test/marker/packed.integration.test.ts"),
        "import { test } from 'bun:test'; test('isolated packed suite', () => {}, 1000);",
      );
      const preload = join(work, "identity-fault.mjs");
      writeFileSync(
        preload,
        `
        const write = process.stdout.write;
        process.stdout.write = function (chunk, ...args) {
          if (process.argv.at(-2) === '--version' && process.argv.at(-1) === '--json') {
            const identity = JSON.parse(String(chunk));
            identity[${JSON.stringify(field)}] = ${JSON.stringify(value)};
            chunk = JSON.stringify(identity) + String.fromCharCode(10);
          }
          return write.call(this, chunk, ...args);
        };
      `,
      );
      const nodeRoot = process.env.FORGE_AUTHOR_NPM_ROOT;
      if (!nodeRoot)
        throw new Error(
          "packed smoke must provide the author Node installation",
        );
      const out = spawnSync(
        join(nodeRoot, process.platform === "win32" ? "node.exe" : "node"),
        [join(author, "tools/pack-smoke/run.ts")],
        {
          cwd: author,
          env: {
            ...process.env,
            FORGE_PACK_INPUT: archive,
            FORGE_PACK_EXPECTED_SHA256: digest,
            FORGE_PACK_EXPECTED_VERSION: build.version,
            CI_HEAD: build.commit,
            NODE_OPTIONS:
              `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
          },
          encoding: "utf8",
          timeout: 45_000,
          windowsHide: true,
        },
      );
      expect(out.status, out.stderr).not.toBe(0);
      expect(out.stderr).toContain("installed build identity");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
}
