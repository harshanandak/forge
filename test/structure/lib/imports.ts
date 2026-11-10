import { builtinModules } from "node:module";
import { posix } from "node:path";
import { FILESYSTEM_OWNERS } from "./filesystem-owners.ts";
import { maskSource } from "./platform.ts";
import type { SourceFile, Violation } from "./repo.ts";
import { CODE_FILE, DETECTOR_MODULE, isTestFile } from "./repo.ts";
import { findWords } from "./words.ts";

export const PACKAGE_NAME = "forge-workflow";

export interface PackageJson {
  readonly name?: string;
  readonly imports?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** `src/adapters/<name>/adapter.json`: the one place a dependency or platform resource is reached. */
export interface AdapterManifest {
  readonly name: string;
  readonly packages: readonly string[];
  readonly executables: readonly string[];
  readonly builtins?: readonly string[];
}

/** Built-in modules that belong to exactly one adapter. */
export const RESTRICTED_BUILTINS: ReadonlyMap<string, string> = new Map([
  ["child_process", "process"],
  ["sqlite", "store-sqlite"],
]);

// Manifest ownership also covers the config filesystem provider. Other OS adapters
// may use filesystem primitives internally without implementing ConfigFiles.
const BUILTIN_PROVIDERS: ReadonlyMap<string, string> = new Map([
  ...RESTRICTED_BUILTINS,
  ["fs", "fs"],
  ["crypto", "oidc"],
]);

const BUILTINS = new Set(
  builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]),
);

const scanners = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/** Normalize TypeScript syntax without removing unused value references. */
export function parsedSource(file: SourceFile): string {
  const loader = /\.[jt]sx$/.test(file.path) ? "tsx" : "ts";
  return new Bun.Transpiler({
    loader,
    deadCodeElimination: false,
  }).transformSync(file.text);
}

/** Import specifiers of a code file, including `import type` (erased at run time, but still a leak). */
export function importsOf(
  file: SourceFile,
  onNonliteral?: () => void,
): string[] {
  if (!CODE_FILE.test(file.path)) return [];
  const found = new Set<string>();
  // Keep type-only dependencies visible in JavaScript-named inputs too.
  const loader = /\.[jt]sx$/.test(file.path) ? "tsx" : "ts";
  const source = file.text.replace(/^\uFEFF/, "").replace(/^#![^\r\n]*/, "");
  try {
    for (const entry of scanners[loader].scan(source).imports)
      found.add(entry.path);
  } catch (cause) {
    throw new Error(`Cannot parse ${file.path} for dependency scanning`, {
      cause,
    });
  }
  const typeImports =
    /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(typeImports)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  const withStrings = maskSource(source, false);
  const codeOnly = maskSource(source, true);
  const calls =
    /(?<![\w$.])(?:import|require)\s*\(\s*(?:["']([^"']+)["']\s*[,)]|)/g;
  for (const match of withStrings.matchAll(calls)) {
    if (codeOnly[match.index] !== match[0][0]) continue;
    if (match[1] === undefined) onNonliteral?.();
    else found.add(match[1]);
  }
  return [...found];
}

const FILESYSTEM_REMEDY =
  "use the project-files port, or add an allowlist entry with a reason in review";

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

const slashPath = (path: string): string => path.replaceAll("\\", "/");
const boundaryPath = (path: string): string =>
  posix.normalize(slashPath(path)).toLowerCase();
const inFolder = (path: string, folder: string): boolean => {
  const normalized = boundaryPath(path);
  return normalized === folder || normalized.startsWith(`${folder}/`);
};

function adapterOf(path: string): string | undefined {
  const match = /^(cloud\/)?src\/adapters\/([^/]+)\//.exec(boundaryPath(path));
  return match === null ? undefined : `${match[1] ?? ""}${match[2]}`;
}

/** Inspect every conditional target: public code must remain independent in every build. */
function packageTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(packageTargets);
}

function schemaTargets(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "$schema" || key === "$ref"
      ? packageTargets(child)
      : schemaTargets(child),
  );
}

function aliasTargets(specifier: string, pkg: PackageJson): string[] {
  const name = pkg.name ?? PACKAGE_NAME;
  const internal = specifier.startsWith("#");
  const key = internal
    ? specifier
    : specifier === name
      ? "."
      : specifier.startsWith(name + "/")
        ? "." + specifier.slice(name.length)
        : undefined;
  if (key === undefined) return [];
  const map = internal ? pkg.imports : pkg.exports;
  if (map === null || typeof map !== "object" || Array.isArray(map))
    return key === "." ? packageTargets(map) : [];
  const entries = Object.entries(map);
  if (!internal && entries.every(([pattern]) => !pattern.startsWith(".")))
    return key === "." ? packageTargets(map) : [];
  const exact = entries.find(([pattern]) => pattern === key);
  if (exact !== undefined) return packageTargets(exact[1]);
  const matches = entries
    .filter(([pattern]) => {
      const [prefix, suffix] = pattern.split("*");
      return (
        suffix !== undefined &&
        key.startsWith(prefix ?? "") &&
        key.endsWith(suffix) &&
        key.length >= (prefix?.length ?? 0) + suffix.length
      );
    })
    .sort(([a], [b]) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  const match = matches[0];
  if (match === undefined) return [];
  const [prefix, suffix] = match[0].split("*");
  const capture = key.slice(
    prefix?.length ?? 0,
    key.length - (suffix?.length ?? 0),
  );
  return packageTargets(match[1]).map((target) =>
    target.replaceAll("*", capture),
  );
}

const TEAM_LOADING_SITES: Readonly<Record<string, string>> = {
  "src/adapters/store-sqlite/index.ts": "Selects Bun or Node SQLite.",
  "src/adapters/process/windows-acl.ts": "Loads the koffi ACL binding.",
  "src/adapters/process/windows-job.ts": "Loads the koffi job binding.",
  "src/assembly/capture.ts": "Resolves installed package roots.",
};

const inTeam = (path: string): boolean =>
  /^(?:(?:dist\/)?team|dist-team)(?:\/|$)/.test(boundaryPath(path));

/** R1/R2: a dependency is imported only inside its adapter, and ports are the only way in. */
export function findDependencyViolations(
  files: readonly SourceFile[],
  pkg: PackageJson,
  adapters: readonly AdapterManifest[],
): Violation[] {
  const violations: Violation[] = [];
  const knownPackages = declared(pkg);
  const runtime = new Set(Object.keys(pkg.dependencies ?? {}));
  const cloud = JSON.parse(
    files.find((file) => boundaryPath(file.path) === "cloud/package.json")
      ?.text ?? "{}",
  ) as PackageJson;
  const cloudPackages = declared(cloud);
  const cloudRuntime = new Set(Object.keys(cloud.dependencies ?? {}));
  if ("imports" in cloud)
    violations.push({
      rule: "dependency-boundary",
      file: "cloud/package.json",
      message: "cloud package imports aliases are not supported",
    });
  const owners = new Map<string, string[]>();
  const cloudAdapters: AdapterManifest[] = [];
  for (const file of files) {
    const name = /^cloud\/src\/adapters\/([^/]+)\/adapter\.json$/.exec(
      boundaryPath(file.path),
    )?.[1];
    if (name === undefined) continue;
    const value: unknown = JSON.parse(file.text);
    if (typeof value !== "object" || value === null) continue;
    const raw = value as { package?: unknown; port?: unknown };
    if (typeof raw.port !== "string") continue;
    const packages = (
      Array.isArray(raw.package) ? raw.package : [raw.package]
    ).filter((value): value is string => typeof value === "string");
    cloudAdapters.push({ name: `cloud/${name}`, packages, executables: [] });
  }
  for (const adapter of [...adapters, ...cloudAdapters]) {
    for (const name of adapter.packages)
      owners.set(name, [
        ...new Set([...(owners.get(name) ?? []), adapter.name]),
      ]);
  }

  for (const file of files) {
    const path = boundaryPath(file.path);
    const here = adapterOf(file.path);
    const inCloud = inFolder(path, "cloud");
    const inShipped = /^(?:src|bin|cloud\/src)\//.test(path);
    const isTest = isTestFile(file.path);
    const unownedFilesystem =
      file.path.startsWith("src/") && !FILESYSTEM_OWNERS.has(file.path);
    if (unownedFilesystem && CODE_FILE.test(file.path)) {
      for (const match of maskSource(file.text, true).matchAll(
        /\bBun\s*\.\s*(file|write)\s*\(/g,
      )) {
        violations.push({
          rule: "dependency-boundary",
          file: file.path,
          message: `uses "Bun.${match[1]}": ${FILESYSTEM_REMEDY}`,
        });
      }
    }

    const publicCode =
      CODE_FILE.test(file.path) && !isTest && !inFolder(path, "team");
    const reportTeam = (message: string): void => {
      violations.push({ rule: "team-boundary", file: file.path, message });
    };
    if (/\.jsonc?$/i.test(file.path)) {
      const config = JSON.parse(maskSource(file.text, false)) as {
        exports?: unknown;
        bin?: unknown;
        files?: unknown;
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      };
      const options = config.compilerOptions;
      const base = posix.join(
        posix.dirname(file.path),
        slashPath(options?.baseUrl ?? "."),
      );
      for (const [alias, targets] of Object.entries(options?.paths ?? {}))
        if (
          targets.some((target) => inTeam(posix.join(base, slashPath(target))))
        )
          reportTeam(
            `paths alias "${alias}" targets removable team/; keep public configuration independent`,
          );
      const targets = /(?:^|\/)adapter\.json$/.test(file.path)
        ? packageTargets(config)
        : [
            ...schemaTargets(config),
            ...(/(?:^|\/)package\.json$/.test(file.path)
              ? [config.exports, config.bin, config.files].flatMap(
                  packageTargets,
                )
              : []),
          ];
      for (const target of targets) {
        const path = slashPath(target).split(/[?#]/)[0]!;
        if (!path || /^[a-z][\w+.-]*:|^\/\//i.test(path)) continue;
        if (inTeam(posix.join(posix.dirname(file.path), path)))
          reportTeam(`manifest path "${target}" reaches removable team/`);
      }
    }
    if (publicCode) {
      if (
        !(file.path in TEAM_LOADING_SITES) &&
        /\bcreateRequire\b/.test(maskSource(file.text, true))
      )
        reportTeam(
          "createRequire can hide team/; use literal imports or an inventoried loader",
        );
      for (const match of file.text.matchAll(
        /^[ \t]*\/\/\/[ \t]*<reference\s+path\s*=\s*["']([^"']+)["']/gim,
      ))
        if (inTeam(posix.join(posix.dirname(file.path), slashPath(match[1]!))))
          reportTeam("triple-slash reference reaches removable team/");
    }
    for (const specifier of importsOf(file, () => {
      if (publicCode && !(file.path in TEAM_LOADING_SITES))
        reportTeam(
          "nonliteral module loading can hide team/; use literal imports and inject providers",
        );
    })) {
      const targets = specifier.startsWith(".")
        ? [
            posix.join(
              posix.dirname(slashPath(file.path)),
              slashPath(specifier),
            ),
          ]
        : aliasTargets(specifier, pkg).map((target) =>
            target.replace(/^\.\//, ""),
          );
      if (publicCode && targets.some(inTeam))
        reportTeam(
          `imports "${specifier}" into removable team/; inject a public contract instead`,
        );

      if (
        publicCode &&
        targets.some(
          (target) =>
            isTestFile(boundaryPath(target)) || /\.test\./i.test(target),
        )
      )
        reportTeam(
          `imports test-named bridge "${specifier}"; public code must not depend on test files`,
        );

      const fail = (message: string): void => {
        violations.push({
          rule: "dependency-boundary",
          file: file.path,
          message: `imports "${specifier}": ${message}`,
        });
      };

      if (inCloud && specifier.startsWith("#")) {
        fail("cloud import aliases are not supported");
        continue;
      }

      if (
        !inCloud &&
        inShipped &&
        targets.some((target) => inFolder(target, "cloud"))
      ) {
        fail("open core cannot import cloud-only code");
        continue;
      }

      if (specifier.startsWith(".")) {
        const target = targets[0]!;
        if (
          inFolder(path, "cloud/src") &&
          inFolder(target, "cloud") &&
          !inFolder(target, "cloud/src")
        ) {
          fail("cloud source cannot import outside cloud/src/");
          continue;
        }
        const into = adapterOf(target.endsWith("/") ? target : `${target}/`);
        const assembly = inFolder(path, "src/assembly");
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
        if (unownedFilesystem && bare.split("/")[0] === "fs") {
          fail(FILESYSTEM_REMEDY);
        }
        const owner = RESTRICTED_BUILTINS.get(bare.split("/")[0] ?? bare);
        if (inShipped && owner !== undefined && here !== owner) {
          fail(`only src/adapters/${owner}/ may use this built-in`);
        }
        continue;
      }

      const name = packageOf(specifier);
      if (name === PACKAGE_NAME) continue;
      if (!knownPackages.has(name) && !(inCloud && cloudPackages.has(name))) {
        fail(`"${name}" is not declared in package.json`);
        continue;
      }
      if (!inShipped) continue;
      if (
        !(inCloud && cloudPackages.has(name)
          ? cloudRuntime.has(name)
          : runtime.has(name))
      ) {
        fail(
          `"${name}" is not in dependencies, so the published package would break for users; move it out of devDependencies`,
        );
        continue;
      }
      const owner = owners
        .get(name)
        ?.filter(
          (candidate) =>
            inFolder(candidate, "cloud") ===
            (inCloud && cloudPackages.has(name)),
        );
      if (owner === undefined || owner.length === 0) {
        fail(
          `"${name}" has no adapter; declare it in src/adapters/<name>/adapter.json`,
        );
      } else if (
        here === undefined ||
        !owner.some((candidate) => candidate.toLowerCase() === here)
      ) {
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
  builtins: { kind: "builtin", claims: (m) => m.builtins ?? [] },
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
    for (const name of manifest.builtins ?? []) {
      const bare = name.replace(/^node:/, "");
      if (!name.startsWith("node:") || !BUILTINS.has(bare)) {
        violations.push({
          rule: "dependency-boundary",
          file: `src/adapters/${manifest.name}/adapter.json`,
          message: `names unknown builtin "${name}"`,
        });
      } else if (BUILTIN_PROVIDERS.get(bare) !== manifest.name) {
        violations.push({
          rule: "dependency-boundary",
          file: `src/adapters/${manifest.name}/adapter.json`,
          message: `builtin "${name}" does not belong to adapter ${manifest.name}`,
        });
      }
    }
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
  DETECTOR_MODULE,
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
