import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function requiredEnvironment(text: string): Set<string> {
  const reference = String.raw`process\.env(?:\.([\w]+)|\[['"]([\w]+)['"]\])`;
  const aliases = new Map<string, string>();
  for (const [, alias, dot, bracket] of text.matchAll(
    new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*${reference}\s*;`, "g"),
  ))
    aliases.set(alias!, (dot ?? bracket)!);

  const required = new Set<string>();
  for (const [, condition] of text.matchAll(
    /\bif\s*\(((?:[^(){};]|\([^()]*\))*)\)\s*(?:\{\s*)?throw\b/g,
  )) {
    for (const [, dot, bracket, alias] of condition!.matchAll(
      new RegExp(String.raw`!(?!=)\s*(?:${reference}|(\w+)\b)`, "g"),
    )) {
      const name = dot ?? bracket ?? aliases.get(alias!);
      if (name) required.add(name);
    }
  }
  return required;
}

type Step = { run?: string; env?: Record<string, string> };
type Workflow = {
  env?: Record<string, string>;
  jobs: { readback: { env?: Record<string, string>; steps: Step[] } };
};

function providedEnvironment(workflow: Workflow, journey: Step): Set<string> {
  const { readback } = workflow.jobs;
  const provided = new Set(
    Object.keys({ ...workflow.env, ...readback.env, ...journey.env }),
  );
  for (const step of readback.steps.slice(0, readback.steps.indexOf(journey))) {
    const helper = step.run?.match(/^node ([\w./-]+\.(?:ts|mjs))$/)?.[1];
    const text = helper ? source(helper) : (step.run ?? "");
    for (const [, appended, shell] of text.matchAll(
      /appendFileSync\(\s*process\.env\.GITHUB_ENV,\s*[`'"]([\w]+)=|^\s*echo\s+["']([\w]+)=[^\n]*>>\s*"?\$GITHUB_ENV/gm,
    ))
      provided.add((appended ?? shell)!);
  }
  return provided;
}

test("release readback supplies the environment required by every registry journey", () => {
  const workflow = parse(source(".github/workflows/release.yml")) as Workflow;
  const journey = workflow.jobs.readback.steps.find((step) =>
    step.run?.startsWith("node tools/release/journeys.mjs "),
  );
  assert.ok(journey?.run);
  const launcher = source(journey.run.split(" ")[1]!);
  const filter = launcher.match(
    /"test",\s*(?:"--[^"]+",\s*|"\d+",\s*)*"([^"]+\.test)",/,
  )?.[1];
  const runnerEnv = launcher.match(/\benv:\s*\{([^{}]+)\}/)?.[1];
  assert.ok(filter && runnerEnv, "release journey selector and environment");
  const provided = providedEnvironment(workflow, journey);
  for (const [, name] of runnerEnv.matchAll(/^\s*(\w+):/gm))
    provided.add(name!);

  const testRoot = new URL("test/", root);
  const files = [
    ...new Bun.Glob(`**/*${filter}*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}`).scanSync({
      cwd: fileURLToPath(testRoot),
    }),
  ].sort();
  assert.ok(files.length, "release journey selector must match test files");
  files.push("integration/packed-consumer.ts");
  const missing = files.flatMap((file) =>
    [...requiredEnvironment(source(`test/${file.replaceAll("\\", "/")}`))]
      .filter((name) => !provided.has(name))
      .map((name) => `${name} (${file})`),
  );
  assert.deepEqual(
    missing,
    [],
    `release readback missing environment: ${missing.join(", ")}`,
  );
}, 1000);

test("release environment requirements include direct reads and local aliases", () => {
  expect(
    requiredEnvironment(`
    const runtime = process.env.RUNTIME;
    if (!runtime || !process.env.ARCHIVE) {
      throw new Error("inputs required");
    }
    if (!process.env["PROOF"]) throw new Error("proof required");
    const optional = process.env.OPTIONAL;
    if (optional !== undefined && optional !== "24") throw new Error("bad value");
  `),
  ).toEqual(new Set(["RUNTIME", "ARCHIVE", "PROOF"]));
}, 1000);
