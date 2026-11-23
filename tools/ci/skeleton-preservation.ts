import { deepStrictEqual, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { gitExecutable } from "../git-executable.ts";

const base = "57025e487efc47d657bd7765649efe66e3f92c0b";
const allowedPaths = new Set([
  ".github/workflows/ci.yml",
  "docs/dependencies.md",
  "hub/LICENSE",
  "hub/THIRD_PARTY_NOTICES.md",
  "hub/bin/forge-hub.mjs",
  "hub/bun.lock",
  "hub/manifests/slack-socket.yaml",
  "hub/package.json",
  "hub/src/main.ts",
  "hub/src/setup/index.ts",
  "hub/test/package.test.ts",
  "hub/test/scaffold.integration.test.ts",
  "hub/tsconfig.json",
  "package.json",
  "test/structure/dependency-boundary.integration.test.ts",
  "test/structure/dependency-ledger.integration.test.ts",
  "test/structure/lib/imports.ts",
  "test/tools/skeleton-preservation.test.ts",
  "test/tools/source-selection.test.ts",
  "tools/ci/node-sensitive.ts",
  "tools/ci/skeleton-preservation.ts",
  "tools/ci/source-selection.ts",
  "tools/ci/test-shards.ts",
  "tsconfig.json",
]);

const condition = "matrix.suite != 'pack'";
const cloudInstall = {
  run: "bun install --frozen-lockfile --ignore-scripts",
  "working-directory": "cloud",
};
const hubInstall = {
  run: "bun install --frozen-lockfile --ignore-scripts --linker hoisted",
  "working-directory": "hub",
};
const preservation = {
  name: "Check skeleton preservation",
  run: "bun tools/ci/skeleton-preservation.ts",
};
const typecheck = { if: condition, run: "bun run check" };
const hubBuild = { if: condition, name: "Build hub", run: "bun run build:hub" };
const scaffoldEntry =
  '  "hub/test/scaffold.integration.test.ts":\n    "Launches selected Node and npm on the built hub package.",\n';

export interface Snapshot {
  workflow: string;
  packageJson: string;
  nodeSensitive: string;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a mapping in the preservation input");
  return value as Record<string, unknown>;
}

function same(left: unknown, right: unknown, description: string): void {
  try {
    deepStrictEqual(left, right);
  } catch {
    throw new Error(`Unexpected change to ${description}`);
  }
}

function stripAfter(
  steps: unknown[],
  anchor: object,
  additions: object[],
  job: string,
): void {
  const index = steps.findIndex((step) => {
    try {
      deepStrictEqual(step, anchor);
      return true;
    } catch {
      return false;
    }
  });
  ok(index >= 0, `Missing existing step in ${job}`);
  same(
    steps.splice(index + 1, additions.length),
    additions,
    `${job} hub steps`,
  );
}

function withoutHubSteps(source: string): object {
  const workflow = record(parse(source, { maxAliasCount: 1000 }));
  const jobs = record(workflow.jobs);
  for (const id of [
    "structure",
    "static",
    "verify",
    "verify-main",
    "verify-node26",
  ]) {
    const job = record(jobs[id]);
    ok(Array.isArray(job.steps), `Expected steps in ${id}`);
    const original: readonly unknown[] = job.steps;
    const steps = original.slice();
    if (id === "structure" || id === "static") {
      stripAfter(
        steps,
        cloudInstall,
        id === "structure" ? [hubInstall, preservation] : [hubInstall],
        id,
      );
    } else {
      stripAfter(
        steps,
        { ...cloudInstall, if: condition },
        [{ ...hubInstall, if: condition }],
        id,
      );
      stripAfter(steps, typecheck, [hubBuild], id);
    }
    job.steps = steps;
  }
  return workflow;
}

export function checkPreservation(
  before: Snapshot,
  after: Snapshot,
  paths: string[],
): void {
  ok(
    paths.every((path) => allowedPaths.has(path)),
    "Changed a path outside the skeleton",
  );
  const basePackage = record(JSON.parse(before.packageJson));
  const scripts = record(basePackage.scripts);
  same(
    JSON.parse(after.packageJson),
    {
      ...basePackage,
      scripts: { ...scripts, "build:hub": "tsc -p hub/tsconfig.json" },
    },
    "root package.json",
  );
  same(
    after.nodeSensitive,
    before.nodeSensitive.replace(/\};\n$/, `${scaffoldEntry}};\n`),
    "Node-sensitive inventory",
  );
  same(
    withoutHubSteps(after.workflow),
    parse(before.workflow, { maxAliasCount: 1000 }),
    "existing CI workflow",
  );
}

export function git(...args: string[]): string {
  return execFileSync(gitExecutable(), args, { encoding: "utf8" });
}

export function changedPaths(
  base: string,
  head: string,
  cwd = process.cwd(),
): string[] {
  return git("-C", cwd, "diff", "--name-only", "--no-renames", "-z", base, head)
    .split("\0")
    .filter(Boolean);
}

function snapshot(ref: string): Snapshot {
  return {
    workflow: git("show", `${ref}:.github/workflows/ci.yml`),
    packageJson: git("show", `${ref}:package.json`),
    nodeSensitive: git("show", `${ref}:tools/ci/node-sensitive.ts`),
  };
}

if (import.meta.main) {
  const head = git("rev-parse", "HEAD").trim();
  checkPreservation(snapshot(base), snapshot(head), changedPaths(base, head));
  console.log(`Preserved existing CI from ${base} to ${head}`);
  process.stdout.write(git("diff", "--no-renames", "--numstat", base, head));
}
