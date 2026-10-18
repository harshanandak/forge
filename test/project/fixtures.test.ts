// Detectors over real repositories on disk: nine fixture folders, each with the files a project
// really has (repo/) and the observations its detectors must return, with their sources (expected.json).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validateDetectionObservation } from "../../src/contract/index.ts";
import {
  createFolderFiles,
  detectProject,
} from "../../src/blocks/project/index.ts";

const base = join(import.meta.dirname, "fixtures");
const names = readdirSync(base).sort();

interface Expected {
  readonly key: string;
  readonly value: unknown;
  readonly file: string;
  readonly pointer?: string;
}

function expectedOf(name: string): Expected[] {
  return JSON.parse(
    readFileSync(join(base, name, "expected.json"), "utf8"),
  ) as Expected[];
}

function snapshot(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else
        out.push(`${relative(directory, full)}:${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(directory);
  return out;
}

test("there are fixtures for every ecosystem and a bare one", () => {
  expect(names).toEqual([
    "bare",
    "bun-app",
    "go-module",
    "node-conflict",
    "npm-vitest",
    "pnpm-jest-workspace",
    "python-uv-pytest",
    "rust-workspace",
    "yarn-hooks-adr",
  ]);
}, 30_000);

for (const name of names) {
  const repo = join(base, name, "repo");

  test(`${name}: detectors return the expected observations, each with its source`, () => {
    const report = detectProject(createFolderFiles(repo));
    expect(report.failures).toEqual([]);
    const got = report.observations.map((o) => ({
      key: o.key,
      value: o.value,
      file: o.origin.file,
      ...(o.origin.pointer === undefined ? {} : { pointer: o.origin.pointer }),
    }));
    expect(got).toEqual(expectedOf(name));
  }, 30_000);

  test(`${name}: every observation is a valid detection naming a file that exists`, () => {
    const { observations } = detectProject(createFolderFiles(repo));
    for (const observation of observations) {
      expect(validateDetectionObservation(observation).ok).toBe(true);
      expect(observation.origin.detector).toBe("project.detect");
      const file = observation.origin.file;
      expect(file).toBeString();
      expect(existsSync(join(repo, file as string))).toBe(true);
    }
  }, 30_000);

  test(`${name}: detection reads only; the folder is untouched`, () => {
    const before = snapshot(repo);
    detectProject(createFolderFiles(repo));
    expect(snapshot(repo)).toEqual(before);
  }, 30_000);
}

test("a folder with no tool files yields no observations: nothing is assumed", () => {
  expect(expectedOf("bare")).toEqual([]);
}, 30_000);

test("the package manager, test runner and commands come from the project, never from a default", () => {
  const byName = new Map(
    names.map((name) => [name, expectedOf(name)] as const),
  );
  const managers = names.map(
    (name) =>
      (
        byName.get(name)?.find((o) => o.key.endsWith("/node/packageManager"))
          ?.value as { name: string } | undefined
      )?.name,
  );
  expect(managers).toEqual([
    undefined, // bare
    "bun",
    undefined, // go-module
    undefined, // node-conflict: two lockfiles disagree and nothing declares a choice
    "npm",
    "pnpm",
    undefined, // python
    undefined, // rust
    "yarn",
  ]);
  const conflict = byName.get("node-conflict") ?? [];
  expect(
    conflict.some((o) => o.key.startsWith("/blocks/check/config/commands/")),
  ).toBe(false);
}, 30_000);
