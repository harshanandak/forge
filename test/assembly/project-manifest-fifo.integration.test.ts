import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_MANIFEST } from "../../src/assembly/project-manifest.ts";

function project() {
  const root = mkdtempSync(join(tmpdir(), "forge-project-manifest-fifo-"));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

const posixTest = process.platform === "win32" ? test.skip : test;

// A FIFO with no writer blocks open() forever, and a blocked synchronous call cannot be timed out
// from inside the test, so each call runs in a child process that the test kills after 10 seconds.
posixTest(
  "a FIFO where the manifest should be is refused without blocking, on read, check and init",
  () => {
    const p = project();
    try {
      mkdirSync(join(p.root, ".forge"));
      expect(spawnSync("mkfifo", [join(p.root, PROJECT_MANIFEST)]).status).toBe(
        0,
      );
      const script =
        "import(process.env.FORGE_T_MODULE).then((m) => {" +
        " try { m[process.env.FORGE_T_CALL](process.env.FORGE_T_ROOT); console.log('none'); }" +
        " catch (e) { console.log(e.error?.code ?? 'other'); } });";
      for (const call of [
        "readProjectManifest",
        "projectManifestExists",
        "initProjectManifest",
      ]) {
        const run = spawnSync(process.execPath, ["-e", script], {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            FORGE_T_MODULE: new URL(
              "../../src/assembly/project-manifest.ts",
              import.meta.url,
            ).href,
            FORGE_T_CALL: call,
            FORGE_T_ROOT: p.root,
          },
        });
        expect(run.error).toBeUndefined();
        expect(run.stdout.trim()).toBe("PROJECT_MANIFEST_UNSAFE");
      }
    } finally {
      p.close();
    }
  },
  30_000,
);
