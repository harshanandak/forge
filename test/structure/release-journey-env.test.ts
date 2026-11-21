import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { optionalJourneyVariables } from "../integration/journey-env.ts";
import { maskSource } from "./lib/platform.ts";

const root = new URL("../../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

const helper = "test/integration/journey-env.ts";
const optionalNames = new Set<string>(optionalJourneyVariables);

function verifyJourneyEnvironment(
  file: string,
  text: string,
  provided: ReadonlySet<string>,
): void {
  const imported = new Set<string>();
  const withoutImports = maskSource(text, false).replace(
    /^ *import\s*\{([\w\s,]+)\}\s*from\s*["'](\.[^"'\n]+)["'] *;?/gm,
    (statement: string, names: string, path: string) => {
      if (posix.normalize(posix.join(posix.dirname(file), path)) !== helper)
        return statement;
      for (const name of names.split(",").map((name) => name.trim()))
        imported.add(name);
      return statement.replace(/[^\r\n]/g, " ");
    },
  );
  const code = maskSource(withoutImports, true);
  const location = (index: number): string =>
    `${file}:${code.slice(0, index).split("\n").length}`;

  const raw =
    /\bprocess\b(?!\s*\.\s*(?:execPath|on|pid|platform)\b)|\bBun\s*(?:\?\.|\.)\s*env\b/g;
  const alternate =
    /\b(?:(?:import|require)\s*\(\s*|(?:from|import)\s+|globalThis\s*(?:\?\.)?\s*\[\s*)["'](?:node:)?process["']|\bBun\s*(?:\?\.)?\s*\[\s*["']env["']/g;
  const direct = raw.exec(code);
  const bypass = [...withoutImports.matchAll(alternate)].find(
    (match) => code[match.index] === match[0][0],
  );
  const ambient = direct ?? bypass;
  assert.ok(
    !ambient,
    `${location(ambient?.index ?? 0)}: use the journey environment helpers instead of reading the ambient environment`,
  );

  for (const match of code.matchAll(
    /\b(?:requireJourneyEnv|optionalJourneyEnv|journeyChildEnv)\b/g,
  )) {
    const [method] = match;
    const at = location(match.index);
    const suffix = withoutImports.slice(match.index + method.length);
    if (method === "journeyChildEnv") {
      assert.ok(
        imported.has(method) && /^\s*\(\s*\)(?!\s*(?:[?.]|\[))/.test(suffix),
        `${at}: use journeyChildEnv only to prepare a child environment`,
      );
      continue;
    }
    const name = /^\s*\(\s*["']([A-Za-z_]\w*)["']\s*[,)]/.exec(suffix)?.[1];
    assert.ok(
      imported.has(method) && name,
      `${at}: ${method} needs a direct import and a literal variable name`,
    );
    if (method === "requireJourneyEnv") {
      assert.ok(
        provided.has(name),
        `${at}: release readback missing environment: ${name}`,
      );
    } else {
      assert.ok(
        optionalNames.has(name),
        `${at}: unapproved optional journey environment: ${name}`,
      );
    }
  }
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

function releaseJourneySelection(): { filter: string; provided: Set<string> } {
  const workflow = parse(source(".github/workflows/release.yml")) as Workflow;
  const journey = workflow.jobs.readback.steps.find(
    (step) => step.run?.split(" ")[1] === "tools/release/journeys.mjs",
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
  assert.match(
    runnerEnv,
    /^\s*FORGE_RELEASE_ACCEPTANCE:\s*"1",/m,
    "release launcher must enable FORGE_RELEASE_ACCEPTANCE",
  );
  return { filter, provided };
}

test("release readback supplies the environment required by every registry journey", () => {
  const { filter, provided } = releaseJourneySelection();
  const testRoot = new URL("test/", root);
  const files = [
    ...new Bun.Glob(`**/*${filter}*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}`).scanSync({
      cwd: fileURLToPath(testRoot),
    }),
  ].sort();
  assert.ok(files.length, "release journey selector must match test files");
  files.push("integration/packed-consumer.ts");
  for (const relative of files) {
    const file = `test/${relative.replaceAll("\\", "/")}`;
    verifyJourneyEnvironment(file, source(file), provided);
  }
}, 1000);

const fixture = "test/fixtures/packed.integration.test.ts";
const contractImport =
  'import { requireJourneyEnv, optionalJourneyEnv, journeyChildEnv } from "../integration/journey-env.ts";\n';

for (const [form, expression] of [
  ["destructuring", "const { RELEASE_PROOF } = process.env;"],
  [
    "typed alias",
    "const proof: string | undefined = process.env.RELEASE_PROOF;",
  ],
  ["optional chaining", "const proof = process.env.RELEASE_PROOF?.trim();"],
  ["bracket property", 'const proof = process.env["RELEASE_PROOF"];'],
  ["bracket environment", 'const proof = process["env"]["RELEASE_PROOF"];'],
  ["imported environment", 'import { env } from "node:process";'],
  ["Bun environment", 'const proof = Bun["env"].RELEASE_PROOF;'],
]) {
  test(`release guard rejects ambient environment access via ${form}`, () => {
    expect(() =>
      verifyJourneyEnvironment(fixture, contractImport + expression, new Set()),
    ).toThrow(`${fixture}:2: use the journey environment helpers`);
  }, 1000);
}

test("release guard reports a declared requirement missing from the workflow", () => {
  const { provided } = releaseJourneySelection();
  const code =
    contractImport + 'requireJourneyEnv("RELEASE_PROOF", "proof required");';
  expect(() => verifyJourneyEnvironment(fixture, code, provided)).toThrow(
    `${fixture}:2: release readback missing environment: RELEASE_PROOF`,
  );
  expect(() =>
    verifyJourneyEnvironment(fixture, code, new Set(["RELEASE_PROOF"])),
  ).not.toThrow();
}, 1000);

test("release guard refuses direct fixture reads from a child environment", () => {
  const code =
    contractImport + "const proof = journeyChildEnv().RELEASE_PROOF;";
  expect(() => verifyJourneyEnvironment(fixture, code, new Set())).toThrow(
    `${fixture}:2: use journeyChildEnv only to prepare a child environment`,
  );
}, 1000);

test("release guard rejects dynamic required names and unapproved optional names", () => {
  expect(() =>
    verifyJourneyEnvironment(
      fixture,
      contractImport + "requireJourneyEnv(name, message);",
      new Set(),
    ),
  ).toThrow(
    `${fixture}:2: requireJourneyEnv needs a direct import and a literal variable name`,
  );
  expect(() =>
    verifyJourneyEnvironment(
      fixture,
      contractImport + 'optionalJourneyEnv("RELEASE_PROOF");',
      new Set(),
    ),
  ).toThrow(
    `${fixture}:2: unapproved optional journey environment: RELEASE_PROOF`,
  );
  expect(() =>
    verifyJourneyEnvironment(
      fixture,
      contractImport + 'optionalJourneyEnv("STATE_NODE_LEG");',
      new Set(),
    ),
  ).not.toThrow();
}, 1000);
