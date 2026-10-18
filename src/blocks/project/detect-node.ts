// Detector for JavaScript and TypeScript projects: package manager, scripts, workspaces and test
// runners, read from package.json, lockfiles and config files. It names tools only to recognise
// them; it never picks one for the project.
import type { DetectionObservation } from "../../generated/types.ts";
import type { ProjectFiles } from "./files.ts";
import {
  command,
  detected,
  firstExisting,
  pointer,
  readJson,
} from "./observation.ts";

const AREA = "node";

/** Lockfile name to the manager that writes it, in the order they are reported. */
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const MANAGERS = new Set(LOCKFILES.map(([, name]) => name));

export type NodeManagerResolution =
  | {
      readonly kind: "detected";
      readonly name: string;
      readonly version?: string;
      readonly evidence: readonly DetectionObservation[];
    }
  | {
      readonly kind: "conflict";
      /** Manager name to the lockfile that implies it. */
      readonly managers: Readonly<Record<string, string>>;
      readonly evidence: readonly DetectionObservation[];
    }
  | { readonly kind: "none"; readonly reason: string };

/**
 * Which package manager the project uses. The manager the project declares in package.json wins
 * over lockfiles; lockfiles that name more than one manager, with no declaration, are a conflict
 * to report, not a choice to make. Returns undefined when there is no package.json at all.
 */
export function resolveNodePackageManager(
  files: ProjectFiles,
): NodeManagerResolution | undefined {
  const manifest = readJson(files, "package.json");
  if (manifest === undefined) return undefined;

  const declared = manifest === null ? undefined : manifest["packageManager"];
  if (typeof declared === "string") {
    const match = /^([a-z]+)@([^+\s]+)/.exec(declared);
    if (match !== null && MANAGERS.has(match[1] as string)) {
      const name = match[1] as string;
      const version = match[2] as string;
      return {
        kind: "detected",
        name,
        version,
        evidence: [
          detected(
            AREA,
            ["packageManager"],
            { name, version },
            {
              file: "package.json",
              pointer: "/packageManager",
            },
          ),
        ],
      };
    }
  }

  const found = new Map<string, string>();
  for (const [file, name] of LOCKFILES) {
    if (files.exists(file) && !found.has(name)) found.set(name, file);
  }
  if (found.size === 1) {
    const [[name, file]] = [...found] as [[string, string]];
    return {
      kind: "detected",
      name,
      evidence: [detected(AREA, ["packageManager"], { name }, { file })],
    };
  }
  if (found.size > 1) {
    const managers = Object.fromEntries(found);
    const first = [...found.values()][0] as string;
    return {
      kind: "conflict",
      managers,
      evidence: [
        detected(AREA, ["packageManagerConflict"], managers, {
          file: first,
          note: "Several lockfiles name different package managers; declare packageManager in package.json to choose one.",
        }),
      ],
    };
  }
  return {
    kind: "none",
    reason:
      "package.json has no packageManager field and the folder has no lockfile",
  };
}

/** The arguments that run one declared script with a manager; never a command Forge chose. */
export function scriptArguments(
  manager: string,
  script: string,
  extra: readonly string[] = [],
): string[] {
  const tail =
    manager === "npm" && extra.length > 0 ? ["--", ...extra] : [...extra];
  return ["run", script, ...tail];
}

/** The same invocation as one line of text, using each manager's short form for `test`. */
export function scriptCommandText(manager: string, script: string): string {
  const short = script === "test" && manager !== "bun";
  return short ? `${manager} test` : `${manager} run ${script}`;
}

/** Names the check block gets from declared scripts, with the script names that supply each. */
const COMMAND_SCRIPTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["test", ["test"]],
  ["lint", ["lint"]],
  ["build", ["build"]],
  ["typecheck", ["typecheck", "type-check", "check-types"]],
  ["format", ["format", "fmt"]],
];

/** What `npm init` writes into a new package: a script that only fails. */
const PLACEHOLDER = /no test specified/i;

const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._@/-]*$/;

interface RunnerSignature {
  readonly name: string;
  readonly packages: readonly string[];
  readonly configs: readonly string[];
}

const CONFIG_EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs", "json"];
const configs = (base: string): string[] =>
  CONFIG_EXTENSIONS.map((ext) => `${base}.${ext}`);

const RUNNERS: readonly RunnerSignature[] = [
  { name: "vitest", packages: ["vitest"], configs: configs("vitest.config") },
  { name: "jest", packages: ["jest"], configs: configs("jest.config") },
  {
    name: "mocha",
    packages: ["mocha"],
    configs: [
      ".mocharc.json",
      ".mocharc.js",
      ".mocharc.cjs",
      ".mocharc.yml",
      ".mocharc.yaml",
    ],
  },
  { name: "ava", packages: ["ava"], configs: configs("ava.config") },
  { name: "tap", packages: ["tap"], configs: [".taprc"] },
  {
    name: "playwright",
    packages: ["@playwright/test"],
    configs: configs("playwright.config"),
  },
];

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

export function detectNode(files: ProjectFiles): DetectionObservation[] {
  const manifest = readJson(files, "package.json");
  if (manifest === undefined) return [];
  if (manifest === null) {
    return [
      detected(AREA, ["unreadable"], true, {
        file: "package.json",
        note: "package.json is not valid JSON, so nothing else could be read from it.",
      }),
    ];
  }

  const out: DetectionObservation[] = [
    detected(AREA, ["present"], true, { file: "package.json" }),
  ];

  const resolution = resolveNodePackageManager(files);
  let manager: string | undefined;
  if (resolution?.kind === "detected") {
    manager = resolution.name;
    out.push(...resolution.evidence);
  } else if (resolution?.kind === "conflict") {
    out.push(...resolution.evidence);
  }

  const workspaces = manifest["workspaces"];
  if (
    Array.isArray(workspaces) ||
    (typeof workspaces === "object" && workspaces !== null)
  ) {
    out.push(
      detected(AREA, ["workspaces"], workspaces, {
        file: "package.json",
        pointer: "/workspaces",
      }),
    );
  } else if (files.exists("pnpm-workspace.yaml")) {
    out.push(
      detected(AREA, ["workspaces"], true, { file: "pnpm-workspace.yaml" }),
    );
  }

  const scripts = stringRecord(manifest["scripts"]);
  if (Object.keys(scripts).length > 0) {
    out.push(
      detected(AREA, ["scripts"], scripts, {
        file: "package.json",
        pointer: "/scripts",
      }),
    );
  }
  const placeholders = Object.entries(scripts)
    .filter(([, body]) => PLACEHOLDER.test(body))
    .map(([name]) => name);
  if (placeholders.length > 0) {
    out.push(
      detected(AREA, ["placeholderScripts"], placeholders, {
        file: "package.json",
        pointer: "/scripts",
        note: "These scripts only print an error; they are not commands to run.",
      }),
    );
  }
  if (manager !== undefined) {
    for (const [name, candidates] of COMMAND_SCRIPTS) {
      const script = candidates.find(
        (candidate) =>
          candidate in scripts &&
          SAFE_SCRIPT_NAME.test(candidate) &&
          !placeholders.includes(candidate),
      );
      if (script === undefined) continue;
      out.push(
        command(name, scriptCommandText(manager, script), {
          file: "package.json",
          pointer: pointer("scripts", script),
        }),
      );
    }
  }

  const dependencies = {
    ...stringRecord(manifest["devDependencies"]),
    ...stringRecord(manifest["dependencies"]),
  };
  const dependencyGroup = (name: string): string =>
    name in stringRecord(manifest["dependencies"])
      ? "dependencies"
      : "devDependencies";
  for (const runner of RUNNERS) {
    const dependency = runner.packages.find((name) => name in dependencies);
    if (dependency !== undefined) {
      out.push(
        detected(
          AREA,
          ["testRunners", runner.name],
          { version: dependencies[dependency] },
          {
            file: "package.json",
            pointer: pointer(dependencyGroup(dependency), dependency),
          },
        ),
      );
      continue;
    }
    const config = firstExisting(files, runner.configs);
    if (config !== undefined) {
      out.push(
        detected(AREA, ["testRunners", runner.name], {}, { file: config }),
      );
    } else if (runner.name === "jest" && "jest" in manifest) {
      out.push(
        detected(
          AREA,
          ["testRunners", "jest"],
          {},
          { file: "package.json", pointer: "/jest" },
        ),
      );
    }
  }

  if (files.exists("tsconfig.json")) {
    out.push(detected(AREA, ["typescript"], true, { file: "tsconfig.json" }));
  } else if ("typescript" in dependencies) {
    out.push(
      detected(AREA, ["typescript"], true, {
        file: "package.json",
        pointer: pointer(dependencyGroup("typescript"), "typescript"),
      }),
    );
  }

  return out;
}
