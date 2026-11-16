// [integration] Fault the real installed CLI's identity output; run the unmodified smoke runner.
import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packedConsumer } from "../../../integration/packed-consumer.ts";

const work = mkdtempSync(join(tmpdir(), "forge-installed-identity-"));
const author = join(work, "author"),
  archive = join(work, "candidate.tgz");
let digest: string,
  build: { version: string; commit: string },
  nodeRoot: string;
beforeAll(() => {
  const packed = process.env.FORGE_PACKED_TARBALL;
  if (!packed) throw new Error("packed smoke must provide its archive");
  copyFileSync(packed, archive);
  digest =
    process.env.FORGE_PACK_EXPECTED_SHA256 ??
    hash("sha256", readFileSync(archive));
  writeFileSync(`${archive}.sha256`, `${digest}  candidate.tgz\n`);
  build = JSON.parse(
    readFileSync(
      join(packedConsumer(), "node_modules/forge-workflow/dist/build.json"),
      "utf8",
    ),
  ) as typeof build;
  const root = resolve(import.meta.dirname, "../../../..");
  // Keep the unmodified runner and its runtime import closure; share read-only inputs across rows.
  for (const path of [
    "tools/pack-smoke",
    "tools/git-executable.ts",
    "src/adapters/process/resolve.ts",
    "src/adapters/process/windows-job.ts",
    "src/adapters/process/errors.ts",
    "src/adapters/process/env.ts",
    "src/adapters/process/platform.ts",
    "package.json",
  ]) {
    const target = join(author, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target, { recursive: true });
  }
  // A real, bounded fixture suite avoids recursively dispatching this acceptance file.
  mkdirSync(join(author, "test/marker"), { recursive: true });
  writeFileSync(
    join(author, "test/marker/packed.integration.test.ts"),
    "import { test } from 'bun:test'; test('isolated packed suite', () => {}, 1000);",
  );
  const runtime = process.env.FORGE_AUTHOR_NPM_ROOT;
  if (!runtime)
    throw new Error("packed smoke must provide the author Node installation");
  nodeRoot = runtime;
}, 30_000);
afterAll(() => rmSync(work, { recursive: true, force: true }), 30_000);

for (const [field, value] of [
  ["version", "wrong-version"],
  ["commit", "f".repeat(40)],
  ["dirty", true],
] as const) {
  test(`installed identity rejects a substituted ${field}`, () => {
    const row = mkdtempSync(join(work, `fault-${field}-`));
    try {
      const preload = join(row, "identity-fault.mjs");
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
      rmSync(row, { recursive: true, force: true });
    }
  }, 60_000);
}
