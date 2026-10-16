import type { Violation } from "./repo.ts";

export const INSTALL_SCRIPTS: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];

/** Packages replaced by a built-in or retired; Bun's own check, lint and fmt are the toolchain. */
export const FORBIDDEN_PACKAGES: readonly RegExp[] = [
  /^cross-spawn$/,
  /^chalk$/,
  /^commander$/,
  /^inquirer$/,
  /^js-yaml$/,
  /^markdown-it$/,
  /^@babel\/parser$/,
  /^lefthook(?:-|$)/,
  /^husky$/,
  /^@commitlint\//,
  /^@stryker-mutator\//,
  /^c8$/,
  /^eslint(?:-|$)/,
  /^@eslint\//,
  /^typescript-eslint$/,
  /^prettier$/,
  /^oxlint(?:-|$)/,
  /^oxfmt$/,
  /^@biomejs\//,
];

export const BUN_FIRST_SCRIPTS: ReadonlyMap<string, string> = new Map([
  ["check", "bun check"],
  ["lint", "bun tools/bun-builtin.ts lint"],
  ["fmt", "bun tools/bun-builtin.ts fmt"],
]);

const STRICT_COMPILER_OPTIONS: readonly string[] = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "verbatimModuleSyntax",
  "erasableSyntaxOnly",
  "rewriteRelativeImportExtensions",
];

/** Shell syntax and flags that let a failed check still exit 0. */
const FAILURE_MASKS: readonly RegExp[] = [
  /\|\|/,
  /;/,
  /\|/,
  /(?<!&)&(?!&)/,
  /[\n\r`]|\$\(/,
  /\bexit\s+0\b/,
  /--(?:passWithNoTests|pass-with-no-tests|exit-zero|no-error-on-unmatched-pattern)\b/i,
];

export function scriptMasksFailure(script: string): boolean {
  return FAILURE_MASKS.some((re) => re.test(script));
}

type Json = Readonly<Record<string, unknown>>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

export function findPackageShapeViolations(
  packageJson: unknown,
  tsconfig: unknown,
): Violation[] {
  const violations: Violation[] = [];
  const fail = (file: string, message: string): void => {
    violations.push({ rule: "package-shape", file, message });
  };
  const pkg = asObject(packageJson);
  const scripts = asObject(pkg.scripts);

  for (const name of INSTALL_SCRIPTS) {
    if (name in scripts) {
      fail(
        "package.json",
        `script "${name}" would run in a consumer's install; remove it`,
      );
    }
  }
  for (const field of [
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    if (field in pkg) {
      fail(
        "package.json",
        `"${field}" is not allowed; every dependency is a plain, adapter-wrapped one`,
      );
    }
  }
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(asObject(pkg[field]))) {
      if (FORBIDDEN_PACKAGES.some((re) => re.test(name))) {
        fail(
          "package.json",
          `"${name}" is retired or replaced by a built-in; see the DROP list`,
        );
      }
    }
  }
  for (const [script, prefix] of BUN_FIRST_SCRIPTS) {
    const value = scripts[script];
    if (
      typeof value !== "string" ||
      !(value === prefix || value.startsWith(`${prefix} `))
    ) {
      fail(
        "package.json",
        `script "${script}" must be "${prefix}": the built-in, reached only through the fail-fast shim`,
      );
    }
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === "string" && scriptMasksFailure(value)) {
      fail(
        "package.json",
        `script "${name}" can hide a failed check (shell operator or exit-zero flag); run the command bare`,
      );
    }
  }
  if (typeof scripts.test !== "string" || !scripts.test.includes("--timeout")) {
    fail(
      "package.json",
      'script "test" must pass an explicit --timeout to bun test',
    );
  }
  if (pkg.type !== "module") fail("package.json", '"type" must be "module"');
  if (typeof asObject(pkg.engines).node !== "string")
    fail("package.json", '"engines.node" is required');
  if (
    !/^bun@\d+\.\d+\.\d+$/.test(
      typeof pkg.packageManager === "string" ? pkg.packageManager : "",
    )
  ) {
    fail(
      "package.json",
      '"packageManager" must pin Bun exactly, for example "bun@1.4.3"',
    );
  }
  if (typeof asObject(pkg.bin).forge !== "string")
    fail("package.json", '"bin.forge" is required');

  const options = asObject(asObject(tsconfig).compilerOptions);
  for (const option of STRICT_COMPILER_OPTIONS) {
    if (options[option] !== true)
      fail("tsconfig.json", `compilerOptions.${option} must be true`);
  }
  if (options.module !== "nodenext")
    fail("tsconfig.json", 'compilerOptions.module must be "nodenext"');
  return violations;
}

/** Syntax Node cannot strip: enums, namespaces, parameter properties, decorators. */
export function findNonErasableSyntax(path: string, text: string): Violation[] {
  const checks: ReadonlyArray<readonly [string, RegExp]> = [
    ["enum", /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w/m],
    [
      "namespace",
      /^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+[\w.]+\s*\{/m,
    ],
    [
      "parameter property",
      /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+\w/,
    ],
    ["decorator", /^\s*@\w+(?:\.\w+)*(?:\([^)]*\))?\s*$/m],
  ];
  const violations: Violation[] = [];
  for (const [name, regex] of checks) {
    if (regex.test(text)) {
      violations.push({
        rule: "package-shape",
        file: path,
        message: `uses ${name}; only syntax Node can strip is allowed`,
      });
    }
  }
  return violations;
}
