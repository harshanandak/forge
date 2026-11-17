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
import { assertInstalledBuildIdentity } from "../../../../tools/pack-smoke/identity.ts";

const work = mkdtempSync(join(tmpdir(), "forge-installed-identity-"));
const author = join(work, "author"),
  archive = join(work, "candidate.tgz");
let digest: string,
  build: { version: string; commit: string; dirty: boolean },
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
  ["runId", "wrong-run"],
  ["missingRunId", null],
  ["missing", null],
] as const) {
  test(`installed identity rejects a substituted ${field}`, async () => {
    const row = mkdtempSync(join(work, `fault-${field}-`));
    try {
      if (
        field === "runId" ||
        field === "missingRunId" ||
        field === "missing"
      ) {
        const { version, commit, dirty } = build;
        const identity = { version, commit, dirty };
        const runId =
          process.env.FORGE_PACK_EXPECTED_RUN_ID ??
          process.env.GITHUB_RUN_ID ??
          null;
        const installed = join(packedConsumer(), "node_modules/forge-workflow");
        expect(() =>
          assertInstalledBuildIdentity(installed, identity, runId),
        ).not.toThrow();
        mkdirSync(join(row, "dist"));
        if (field !== "missing")
          writeFileSync(
            join(row, "dist/build.json"),
            JSON.stringify(
              field === "missingRunId"
                ? { version, commit, dirty: false }
                : { ...build, runId: value },
            ),
          );
        const expectedRun = field === "missingRunId" ? "12345" : runId;
        expect(() =>
          assertInstalledBuildIdentity(row, identity, expectedRun),
        ).toThrow(field === "missing" ? "ENOENT" : "installed build identity");
        const source = readFileSync(
          resolve(
            import.meta.dirname,
            "../../../../tools/pack-smoke/identity.ts",
          ),
          "utf8",
        );
        const removed = source.replace(
          / {2}assert\.deepEqual\([\s\S]*?\n {2}\);/,
          "",
        );
        expect(removed).not.toBe(source);
        const mutant = join(row, "identity.ts");
        writeFileSync(mutant, removed);
        const unguarded = (await import(
          pathToFileURL(mutant).href
        )) as typeof import("../../../../tools/pack-smoke/identity.ts");
        expect(() =>
          unguarded.assertInstalledBuildIdentity(row, identity, expectedRun),
        ).not.toThrow();
        return;
      }
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
