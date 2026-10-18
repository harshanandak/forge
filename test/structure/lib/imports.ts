import { builtinModules } from "node:module";
import { posix } from "node:path";
import type { SourceFile, Violation } from "./repo.ts";
import { CODE_FILE, TEST_FILE } from "./repo.ts";
import { findWords } from "./words.ts";

export const PACKAGE_NAME = "forge-workflow";

export interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** `src/adapters/<name>/adapter.json`: the one place a dependency or external executable is reached. */
export interface AdapterManifest {
  readonly name: string;
  readonly packages: readonly string[];
  readonly executables: readonly string[];
}

/** Built-in modules that belong to exactly one adapter. */
export const RESTRICTED_BUILTINS: ReadonlyMap<string, string> = new Map([
  ["child_process", "process"],
  ["sqlite", "store-sqlite"],
]);

const BUILTINS = new Set(
  builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]),
);

const scanner = new Bun.Transpiler({ loader: "ts" });

/** Import specifiers of a code file, including `import type` (erased at run time, but still a leak). */
export function importsOf(file: SourceFile): string[] {
  if (!CODE_FILE.test(file.path)) return [];
  const found = new Set<string>();
  try {
    for (const entry of scanner.scanImports(file.text)) found.add(entry.path);
  } catch {
    // unparsable files are reported by the type check, not here
  }
  const typeImports =
    /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
  for (const match of file.text.matchAll(typeImports)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

export function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

function declared(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

function adapterOf(path: string): string | undefined {
  return /^src\/adapters\/([^/]+)\//.exec(path)?.[1];
}

/** R1/R2: a dependency is imported only inside its adapter, and ports are the only way in. */
export function findDependencyViolations(
  files: readonly SourceFile[],
  pkg: PackageJson,
  adapters: readonly AdapterManifest[],
): Violation[] {
  const violations: Violation[] = [];
  const knownPackages = declared(pkg);
  const runtime = new Set(Object.keys(pkg.dependencies ?? {}));
  const owners = new Map<string, string[]>();
  for (const adapter of adapters) {
    for (const name of adapter.packages)
      owners.set(name, [...(owners.get(name) ?? []), adapter.name]);
  }

  for (const file of files) {
    const here = adapterOf(file.path);
    const inShipped = /^(?:src|bin)\//.test(file.path);
    const isTest =
      TEST_FILE.test(file.path) || /(?:^|\/)test\//.test(file.path);

    for (const specifier of importsOf(file)) {
      const fail = (message: string): void => {
        violations.push({
          rule: "dependency-boundary",
          file: file.path,
          message: `imports "${specifier}": ${message}`,
        });
      };

      if (specifier.startsWith(".")) {
        const target = posix.normalize(
          posix.join(posix.dirname(file.path), specifier),
        );
        const into = adapterOf(target.endsWith("/") ? target : `${target}/`);
        const assembly = file.path.startsWith("src/assembly/");
        if (inShipped && into !== undefined && into !== here && !assembly) {
          fail(
            `reaches into adapter "${into}"; import its port from src/ports instead`,
          );
        }
        continue;
      }
      if (specifier.startsWith("#")) continue;

      if (specifier.startsWith("bun:")) {
        const allowed =
          here !== undefined ||
          (isTest && specifier === "bun:test") ||
          !inShipped;
        if (!allowed)
          fail(
            "Bun APIs never appear in the published package; use them only inside an adapter",
          );
        continue;
      }

      const bare = specifier.replace(/^node:/, "");
      const builtin = BUILTINS.has(bare.split("/")[0] ?? bare);
      if (builtin) {
        const owner = RESTRICTED_BUILTINS.get(bare.split("/")[0] ?? bare);
        if (inShipped && owner !== undefined && here !== owner) {
          fail(`only src/adapters/${owner}/ may use this built-in`);
        }
        continue;
      }

      const name = packageOf(specifier);
      if (name === PACKAGE_NAME) continue;
      if (!knownPackages.has(name)) {
        fail(`"${name}" is not declared in package.json`);
        continue;
      }
      if (!inShipped) continue;
      if (!runtime.has(name)) {
        fail(
          `"${name}" is not in dependencies, so the published package would break for users; move it out of devDependencies`,
        );
        continue;
      }
      const owner = owners.get(name);
      if (owner === undefined) {
        fail(
          `"${name}" has no adapter; declare it in src/adapters/<name>/adapter.json`,
        );
      } else if (here === undefined || !owner.includes(here)) {
        fail(
          `"${name}" belongs to adapter ${owner.join(", ")}; import its port, never the package`,
        );
      }
    }
  }
  return violations;
}

/** Every resource kind an adapter manifest can claim; a new manifest field fails to compile until listed here. */
const CLAIM_KINDS: Record<
  Exclude<keyof AdapterManifest, "name">,
  {
    readonly kind: string;
    readonly claims: (m: AdapterManifest) => readonly string[];
  }
> = {
  packages: { kind: "package", claims: (m) => m.packages },
  executables: { kind: "executable", claims: (m) => m.executables },
};

/** Each claimed resource, of any kind, sits behind exactly one adapter. */
export function findDuplicateClaims(
  manifests: readonly AdapterManifest[],
): Violation[] {
  const violations: Violation[] = [];
  for (const { kind, claims } of Object.values(CLAIM_KINDS)) {
    const claimants = new Map<string, string[]>();
    for (const manifest of manifests) {
      for (const resource of new Set(claims(manifest)))
        claimants.set(resource, [
          ...(claimants.get(resource) ?? []),
          manifest.name,
        ]);
    }
    for (const [resource, names] of claimants) {
      if (names.length > 1) {
        violations.push({
          rule: "dependency-boundary",
          file: "package.json",
          message: `${kind} "${resource}" is claimed by adapters ${names.join(", ")}; each ${kind} sits behind exactly one adapter`,
        });
      }
    }
  }
  return violations;
}

/** Every adapter has a manifest, and every runtime dependency is claimed by one. */
export function findAdapterViolations(
  adapterDirs: readonly string[],
  manifests: readonly AdapterManifest[],
  pkg: PackageJson,
): Violation[] {
  const violations: Violation[] = [];
  const have = new Set(manifests.map((m) => m.name));
  for (const dir of adapterDirs) {
    if (!have.has(dir)) {
      violations.push({
        rule: "dependency-boundary",
        file: `src/adapters/${dir}`,
        message:
          "adapter has no valid adapter.json ({ package | executable | builtin, port })",
      });
    }
  }
  violations.push(...findDuplicateClaims(manifests));
  const claimed = new Set(manifests.flatMap((m) => m.packages));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!claimed.has(name)) {
      violations.push({
        rule: "dependency-boundary",
        file: "package.json",
        message: `runtime dependency "${name}" has no adapter; each dependency sits behind one src/adapters/<name>/`,
      });
    }
  }
  for (const manifest of manifests) {
    for (const name of manifest.packages) {
      if (!declared(pkg).has(name)) {
        violations.push({
          rule: "dependency-boundary",
          file: `src/adapters/${manifest.name}/adapter.json`,
          message: `names package "${name}" which is not declared in package.json`,
        });
      }
    }
  }
  return violations;
}

/** Shipped code never names a package manager, test runner, linter or hook runner outside adapters and detectors. */
export const TOOLCHAIN_TERMS: ReadonlySet<string> = new Set([
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "vitest",
  "jest",
  "pytest",
  "eslint",
  "lefthook",
  "husky",
]);

export const TOOLCHAIN_EXEMPT: readonly RegExp[] = [
  /^src\/adapters\//,
  /^src\/blocks\/project\//,
  /^src\/blocks\/migrate\/legacy\//,
];

export function findToolchainNames(files: readonly SourceFile[]): Violation[] {
  const shipped = files.filter(
    (f) =>
      /^(?:src|bin)\//.test(f.path) &&
      CODE_FILE.test(f.path) &&
      !TOOLCHAIN_EXEMPT.some((re) => re.test(f.path)),
  );
  return findWords(
    shipped,
    TOOLCHAIN_TERMS,
    new Map(),
    "toolchain-names",
    (term) =>
      `shipped code names "${term}"; our toolchain is not the user's, so only adapters and detectors may`,
  );
}
