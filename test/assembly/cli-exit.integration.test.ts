import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function invoke(action: string, argv = ["check", "run"], assembly = false) {
  const node = Bun.which("node");
  if (!node) throw Error("Node runtime required");
  const target = assembly
    ? "/src/assembly/index.js"
    : "/src/assembly/command.js";
  const source = assembly
    ? `export async function createLocalAssembly() {
        return { catalog: { list: () => [], invoke: async () => ({}) },
          close: async () => { ${action}; } };
      }
      export function localCall() { return { caller: 'agent' }; }
      export function localContext() { return {}; }
      export function localSession(session) { return session; }`
    : `export async function runLocalCommand() { ${action}; }`;
  const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, next) {
      if (url.endsWith(${JSON.stringify(target)})) return {
        format: 'module', shortCircuit: true, source: ${JSON.stringify(source)},
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
      ...argv,
    ],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  if (result.stdout === "") throw new Error(result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

for (const action of [
  "process.exit(1)",
  "await new Promise(() => {})",
  "throw new Error('injected rejection')",
  "setImmediate(() => { throw new Error('injected uncaught'); }); await new Promise(() => {})",
]) {
  for (const argv of [
    ["check", "run"],
    ["check.run"],
    ["--json", "check", "run"],
    ["--hook", "check.run"],
    ["--input", "{}", "--dry-run", "check.run"],
  ]) {
    test(`built CLI names an unfinished invocation: ${argv.join(" ")}: ${action}`, () => {
      expect(invoke(action, argv)).toMatchObject({
        ok: false,
        op: "check.run",
        error: {
          code: "CLI_INTERRUPTED",
          message: "CLI terminated before check.run returned a result",
        },
      });
    }, 15000);
  }
}

for (const action of ["await new Promise(() => {})", "process.exit(1)"]) {
  test(`built CLI preserves the result when assembly.close abandons: ${action}`, () => {
    expect(invoke(action, ["catalog", "list"], true)).toMatchObject({
      ok: true,
      op: "catalog.list",
    });
  }, 15000);
}
