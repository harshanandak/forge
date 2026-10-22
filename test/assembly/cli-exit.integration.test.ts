import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

for (const action of ["process.exit(1)", "await new Promise(() => {})"]) {
  test(`built CLI names an unfinished invocation: ${action}`, () => {
    const node = Bun.which("node");
    if (!node) throw Error("Node runtime required");
    const preload = `
      import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/src/assembly/command.js')) return {
          format: 'module', shortCircuit: true,
          source: ${JSON.stringify(`export async function runLocalCommand() { ${action}; }`)},
        };
        return next(url, context);
      } });
    `;
    const result = spawnSync(
      node,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        resolve(import.meta.dirname, "../../dist/bin/forge.js"),
        "check",
        "run",
      ],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      op: "check.run",
      error: {
        code: "CLI_INTERRUPTED",
        message: "CLI terminated before check.run returned a result",
      },
    });
  }, 15000);
}
