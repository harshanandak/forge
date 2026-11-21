// [integration] Exercise the plain-Node release launcher with the real installed identity fixtures.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveBun } from "../../../../tools/pack-smoke/environment.ts";
import {
  journeyChildEnv,
  requireJourneyEnv,
} from "../../../integration/journey-env.ts";
import { packedConsumer } from "../../../integration/packed-consumer.ts";

test("plain Node release gate reaches each installed identity refusal with a Bun-free consumer PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-release-launcher-"));
  try {
    const root = resolve(import.meta.dirname, "../../../..");
    for (const path of [
      "tools/pack-smoke",
      "tools/git-executable.ts",
      "src/adapters/process",
      "package.json",
      "test/tools/pack-smoke/identity/packed.integration.test.ts",
      "test/integration/packed-consumer.ts",
      "test/integration/journey-env.ts",
    ]) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, path), target, { recursive: true });
    }
    mkdirSync(join(dir, "test/marker"), { recursive: true });
    writeFileSync(
      join(dir, "test/marker/packed.integration.test.ts"),
      "import {test,expect} from 'bun:test'; test('consumer PATH has no Bun',()=>expect(Bun.which('bun')).toBeNull(),1000);",
    );
    const runtime = requireJourneyEnv(
      "FORGE_AUTHOR_NPM_ROOT",
      "packed artifact and author Node required",
    );
    const tarball = requireJourneyEnv(
      "FORGE_PACKED_TARBALL",
      "packed artifact and author Node required",
    );
    const env: NodeJS.ProcessEnv = {
      ...journeyChildEnv(),
      npm_execpath: "",
      NO_COLOR: "1",
    };
    const pathKey =
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = dirname(resolveBun()) + delimiter + (env[pathKey] ?? "");
    const out = spawnSync(
      join(runtime, process.platform === "win32" ? "node.exe" : "node"),
      [
        join(root, "tools/release/journeys.mjs"),
        dir,
        packedConsumer(),
        tarball,
      ],
      { env, encoding: "utf8", windowsHide: true, timeout: 180_000 },
    );
    expect(out.error).toBeUndefined();
    const output = out.stdout + out.stderr;
    expect(out.status).not.toBe(0);
    expect(output).toContain("missing required release journey:");
    expect(output).toContain("(pass) consumer PATH has no Bun");
    for (const field of ["version", "commit", "dirty"])
      expect(output).toContain(
        `(pass) installed identity rejects a substituted ${field}`,
      );
    expect(output).not.toContain("bun is not resolvable on PATH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 210_000);
