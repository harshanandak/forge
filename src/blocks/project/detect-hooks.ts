// Detector for the project's own git hook setup: which hook manager it uses and what its pre-commit
// step runs. It only reports. Forge never installs a manager, never duplicates a gate the project
// already runs, and never replaces what is there.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import { detected, readJson } from "./observation.ts";

const AREA = "hooks";

const LEFTHOOK_FILES = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  "lefthook-local.yml",
  "lefthook-local.yaml",
];
const PRE_COMMIT_FRAMEWORK_FILES = [
  ".pre-commit-config.yaml",
  ".pre-commit-config.yml",
];
const SIMPLE_HOOKS_FILES = [
  ".simple-git-hooks.json",
  ".simple-git-hooks.cjs",
  ".simple-git-hooks.js",
];

/** Tokens that make a pre-commit command a source-to-test coupling gate; narrow on purpose. */
const TEST_GATE_PATTERNS: readonly RegExp[] = [
  /(^|[^a-z0-9])tdd([^a-z0-9]|$)/i,
  /(source[-_. ]?test|test[-_. ]?source)/i,
  /((test|spec)[-_. ]?coupling|coupling[-_. ]?(test|spec|check))/i,
  /(require|enforce|verify|guard)[-_. ]?(tests?|specs?)([^a-z0-9]|$)/i,
  /check[-_. ]?(tests?|specs?)([^a-z0-9]|$)/i,
];

export function looksLikeTestGate(text: string): boolean {
  return TEST_GATE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Keys that group jobs rather than name one. */
const STRUCTURAL_KEYS = new Set([
  "commands",
  "scripts",
  "jobs",
  "parallel",
  "piped",
]);

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** Script hooks (a manager's hook file, or a raw hook): every meaningful line is a command. */
function scriptCommands(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !line.startsWith("#") &&
        !/^\.\s+.*_\/\w+\.sh/.test(line) &&
        !/^(?:set|export)\s/.test(line),
    );
}

/** The `run:` and `name:` values under a top-level `pre-commit:` key of a hook manager's YAML. */
function yamlPreCommitCommands(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inside = /^pre-commit\s*:/.test(line);
      continue;
    }
    if (!inside) continue;
    const entry = /^\s*(?:-\s+)?(run|name)\s*:\s*(.+?)\s*$/.exec(line);
    if (entry !== null) out.push(unquote(entry[2] as string));
    else {
      const named = /^\s{2,}([A-Za-z0-9_-]+)\s*:\s*$/.exec(line);
      if (named !== null && !STRUCTURAL_KEYS.has(named[1] as string))
        out.push(named[1] as string);
    }
  }
  return out;
}

/** `id`, `name` and `entry` values of a pre-commit framework config. */
function frameworkCommands(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s*(?:-\s+)?(id|name|entry)\s*:\s*(.+?)\s*$/.exec(line);
    if (entry !== null) out.push(unquote(entry[2] as string));
  }
  return [...new Set(out)];
}

interface Found {
  readonly name: string;
  readonly files: string[];
  readonly preCommit: string[];
}

function dependencyIn(
  manifest: Record<string, unknown> | null | undefined,
  name: string,
): string | undefined {
  if (manifest === null || manifest === undefined) return undefined;
  for (const group of ["devDependencies", "dependencies"]) {
    const entries = manifest[group];
    if (typeof entries === "object" && entries !== null && name in entries) {
      return `/${group}/${name}`;
    }
  }
  return undefined;
}

export function detectHooks(files: ProjectFiles): DetectionObservation[] {
  const manifest = readJson(files, "package.json");
  const found: Found[] = [];

  const lefthook = LEFTHOOK_FILES.filter((file) => files.exists(file));
  if (lefthook.length > 0) {
    found.push({
      name: "lefthook",
      files: lefthook,
      preCommit: lefthook.flatMap((file) =>
        yamlPreCommitCommands(files.read(file) ?? ""),
      ),
    });
  } else if (dependencyIn(manifest, "lefthook") !== undefined) {
    found.push({ name: "lefthook", files: ["package.json"], preCommit: [] });
  }

  if (files.isDirectory(".husky")) {
    const hookFiles = files
      .list(".husky")
      .filter((name) => !name.startsWith("_") && !name.includes("."))
      .map((name) => `.husky/${name}`);
    found.push({
      name: "husky",
      files: [".husky", ...hookFiles],
      preCommit: scriptCommands(files.read(".husky/pre-commit") ?? ""),
    });
  } else if (dependencyIn(manifest, "husky") !== undefined) {
    found.push({ name: "husky", files: ["package.json"], preCommit: [] });
  }

  const framework = PRE_COMMIT_FRAMEWORK_FILES.filter((file) =>
    files.exists(file),
  );
  if (framework.length > 0) {
    found.push({
      name: "pre-commit",
      files: framework,
      preCommit: framework.flatMap((file) =>
        frameworkCommands(files.read(file) ?? ""),
      ),
    });
  }

  const simple = SIMPLE_HOOKS_FILES.filter((file) => files.exists(file));
  const simpleInManifest =
    manifest !== null &&
    manifest !== undefined &&
    "simple-git-hooks" in manifest;
  if (simple.length > 0 || simpleInManifest) {
    const config = simple.includes(".simple-git-hooks.json")
      ? readJson(files, ".simple-git-hooks.json")
      : simpleInManifest
        ? manifest["simple-git-hooks"]
        : undefined;
    const preCommit =
      typeof config === "object" && config !== null
        ? (config as Record<string, unknown>)["pre-commit"]
        : undefined;
    found.push({
      name: "simple-git-hooks",
      files: simple.length > 0 ? simple : ["package.json"],
      preCommit: typeof preCommit === "string" ? [preCommit] : [],
    });
  }

  // Hooks written straight into .git/hooks, without a manager. Git's own samples do not count.
  const raw = files
    .list(".git/hooks")
    .filter((name) => !name.endsWith(".sample"))
    .map((name) => `.git/hooks/${name}`);
  if (raw.length > 0) {
    found.push({
      name: "raw",
      files: raw,
      preCommit: scriptCommands(files.read(".git/hooks/pre-commit") ?? ""),
    });
  }

  const out: DetectionObservation[] = [];
  for (const manager of found) {
    out.push(
      detected(
        AREA,
        ["managers", manager.name],
        { files: manager.files },
        {
          file: manager.files[0] as string,
        },
      ),
    );
  }
  for (const manager of found) {
    if (manager.preCommit.length === 0) continue;
    out.push(
      detected(
        AREA,
        ["preCommit", manager.name],
        { commands: manager.preCommit },
        {
          file:
            manager.files.find((file) => file !== ".husky") ??
            (manager.files[0] as string),
        },
      ),
    );
  }
  for (const manager of found) {
    const gate = manager.preCommit.find((entry) => looksLikeTestGate(entry));
    if (gate !== undefined) {
      out.push(
        detected(
          AREA,
          ["existingTestGate"],
          { manager: manager.name, command: gate },
          {
            file:
              manager.files.find((file) => file !== ".husky") ??
              (manager.files[0] as string),
            note: "The project already runs a source-to-test gate on pre-commit; Forge reports it and adds no second one.",
          },
        ),
      );
      break;
    }
  }
  return out;
}
