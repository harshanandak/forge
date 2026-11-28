/// <reference types="bun" />

import { ok } from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { expect, test } from "bun:test";
import { SECRET_PATTERNS } from "../src/contract/errors.js";
import { hubTestTemp } from "./temp.ts";

const timeout = 30_000;
const hub = realpathSync(resolve(import.meta.dir, ".."));
const bin = join(hub, "bin/forge-hub.mjs");
const dist = join(hub, "dist");
const mainUrl = pathToFileURL(join(dist, "main.js")).href;
const usage = "usage: forge-hub <command>\n";
const execFileAsync = promisify(execFile);

function node(args: string[], cwd: string, env = {}) {
  return spawnSync("node", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
}

function isolatedNode(
  args: string[],
  exit: number,
  stdout: string,
  stderr: string,
  env = {},
): void {
  const cwd = hubTestTemp("forge-hub-cli-");
  try {
    const result = node(args, cwd, env);
    expect(result.status).toBe(exit);
    ok(result.stdout === stdout, "Unexpected hub stdout");
    ok(result.stderr === stderr, "Unexpected hub stderr");
    ok(
      readdirSync(cwd).length === 0,
      "The hub changed its working directory contents",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test(
  "hub build emits JavaScript under the package dist directory",
  () => {
    ok(
      statSync(join(dist, "main.js")).isFile(),
      "Expected the built hub entry",
    );
    const outputs = readdirSync(dist, { recursive: true, withFileTypes: true });
    ok(
      outputs.every(
        (file) =>
          file.isDirectory() || (file.isFile() && file.name.endsWith(".js")),
      ),
      "Unexpected hub build output",
    );
    const rootDist = resolve(hub, "../dist");
    for (const path of ["main.js", "setup/index.js", "hub"])
      ok(
        !existsSync(join(rootDist, path)),
        "Hub output escaped into root dist",
      );
  },
  timeout,
);

test(
  "doctor reports its stub exit and output",
  () => {
    isolatedNode([bin, "doctor"], 1, "", "not_built: doctor\n");
  },
  timeout,
);

test(
  "init returns its stub result without reading or echoing configuration",
  () => {
    isolatedNode(
      [bin, "init", "--profile", "laptop", "--config", "./missing.yaml"],
      1,
      "",
      "not_built: init\n",
      {
        FORGE_HUB_CONFIG: "./also-missing.yaml",
      },
    );
  },
  timeout,
);

test(
  "no argument and an unknown command print usage and exit 2",
  () => {
    for (const args of [[bin], [bin, "bogus"]])
      isolatedNode(["--no-experimental-sqlite", ...args], 2, "", usage);
  },
  timeout,
);

test(
  "the exported main returns CLI exit codes when called",
  () => {
    isolatedNode(
      [
        "--input-type=module",
        "-e",
        "const { main } = await import(" +
          JSON.stringify(mainUrl) +
          ");" +
          'console.log(await main(["doctor"])); console.log(await main(["bogus"]));',
      ],
      0,
      "1\n2\n",
      "not_built: doctor\n" + usage,
    );
  },
  timeout,
);

const ownFiles = [
  "package.json",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "bin/forge-hub.mjs",
  "manifests/slack-socket.yaml",
  "dist/adapters/windows-security.js",
  "dist/chat/canvas.js",
  "dist/chat/cards.js",
  "dist/chat/config.js",
  "dist/chat/failure.js",
  "dist/chat/inbound.js",
  "dist/chat/index.js",
  "dist/chat/logger.js",
  "dist/chat/probe.js",
  "dist/chat/slack.js",
  "dist/chat/state.js",
  "dist/chat/summary.js",
  "dist/chat/telegram-cards.js",
  "dist/chat/telegram-polling.js",
  "dist/chat/telegram-wire.js",
  "dist/chat/telegram.js",
  "dist/contract/chat-state.js",
  "dist/contract/chat.js",
  "dist/contract/core.js",
  "dist/contract/domain.js",
  "dist/contract/errors.js",
  "dist/contract/hooks.js",
  "dist/contract/ids.js",
  "dist/contract/mcp.js",
  "dist/contract/runtime.js",
  "dist/contract/windows-security.js",
  "dist/core/agent-posts.js",
  "dist/core/answer.js",
  "dist/core/answers.js",
  "dist/core/askEffects.js",
  "dist/core/asks.js",
  "dist/core/cli.js",
  "dist/core/compose.js",
  "dist/core/config.js",
  "dist/core/context.js",
  "dist/core/core.js",
  "dist/core/credentials.js",
  "dist/core/db.js",
  "dist/core/directory.js",
  "dist/core/doorbell.js",
  "dist/core/effects.js",
  "dist/core/errors.js",
  "dist/core/guards.js",
  "dist/core/inbox.js",
  "dist/core/index.js",
  "dist/core/protect.js",
  "dist/core/reply.js",
  "dist/core/report.js",
  "dist/core/routing.js",
  "dist/core/schema-probe.js",
  "dist/core/schema.js",
  "dist/core/send.js",
  "dist/core/sessions.js",
  "dist/core/stop.js",
  "dist/core/storage.js",
  "dist/core/store-impl.js",
  "dist/core/store.js",
  "dist/core/thread.js",
  "dist/core/waiters.js",
  "dist/core/windows-security-create.js",
  "dist/core/windows-security-read.js",
  "dist/core/windows-security.js",
  "dist/core/worker-lock.js",
  "dist/main.js",
  "dist/remote/index.js",
  "dist/service/http.js",
  "dist/service/routes.js",
  "dist/service/serve.js",
  "dist/setup/index.js",
];
const credentialPath =
  /(?:^|\/)(?:\.(?:env|secrets|dev\.vars)(?:[./]|$)|\.npmrc$|id_(?:rsa|ed25519)(?:\.|$)|[^/]+\.(?:pem|key|pfx|p12)$)/i;

function safePath(path: string): void {
  ok(
    path !== "." &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.split("/").includes("..") &&
      posix.normalize(path) === path &&
      !credentialPath.test(path),
    "Unsafe pack path",
  );
}

function record(value: unknown): Record<string, unknown> {
  ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected a package mapping",
  );
  return value as Record<string, unknown>;
}

function manifest(folder: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(join(folder, "package.json"), "utf8")));
}

const fields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
type Package = {
  path: string;
  metadata: Record<string, unknown>;
  notices: string[];
};

function installedFolder(owner: string, name: string): string | undefined {
  ok(/^(?:@[\w.-]+\/)?[\w-][\w.-]*$/.test(name), "Invalid dependency name");
  for (
    let folder = owner;
    folder === hub || folder.startsWith(hub + sep);
    folder = dirname(folder)
  ) {
    if (basename(folder) === "node_modules") continue;
    const candidate = join(folder, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      ok(
        realpathSync(candidate) === candidate,
        "Bundled dependency must be physically installed inside hub",
      );
      return candidate;
    }
  }
  return undefined;
}

function installedClosure(): Map<string, Package> {
  const closure = new Map<string, Package>();
  function visit(folder: string, metadata: Record<string, unknown>): void {
    const optional = record(metadata.optionalDependencies ?? {});
    const peerMeta = record(metadata.peerDependenciesMeta ?? {});
    for (const field of fields) {
      for (const name of Object.keys(record(metadata[field] ?? {}))) {
        if (
          field === "peerDependencies" &&
          record(peerMeta[name] ?? {}).optional === true
        )
          continue;
        const path = installedFolder(folder, name);
        if (path === undefined) {
          ok(
            field === "optionalDependencies" || Object.hasOwn(optional, name),
            "Required dependency is missing from the hub install",
          );
          continue;
        }
        const key = relative(hub, path).split(sep).join("/");
        if (closure.has(key)) continue;
        const installed = manifest(path);
        ok(
          installed.name === name && typeof installed.version === "string",
          "Bundled dependency identity is invalid",
        );
        if (folder === hub)
          ok(
            installed.version === record(metadata.dependencies)[name],
            "Direct dependency pin differs from the hub install",
          );
        const notices = readdirSync(path).filter((name) =>
          /^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(name),
        );
        closure.set(key, { path, metadata: installed, notices });
        visit(path, installed);
      }
    }
  }
  visit(hub, manifest(hub));
  return closure;
}

function stringTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, target]) =>
    name !== "types" ? stringTargets(target) : [],
  );
}

function runtimeTargets(
  metadata: Record<string, unknown>,
  files: string[],
): void {
  const targets = [
    metadata.main === "" ? undefined : metadata.main,
    metadata.module,
    metadata.bin,
    metadata.exports,
  ].flatMap(stringTargets);
  for (const value of targets) {
    const target = value.replace(/^\.\//, "");
    safePath(target);
    const present = target.includes("*")
      ? files.some((file) => new Bun.Glob(target).match(file))
      : [
          target,
          target + ".js",
          target + ".json",
          target + ".node",
          target + "/index.js",
        ].some((path) => files.includes(path));
    ok(present, "Bundle omitted a declared runtime target");
  }
}

function npmManifestPath(): string {
  const executable = Bun.which("npm");
  ok(executable, "Selected npm is required");
  return process.platform === "win32"
    ? join(dirname(executable), "node_modules/npm/package.json")
    : resolve(dirname(realpathSync(executable)), "../package.json");
}

async function packableFiles(
  npm: string,
  closure: Map<string, Package>,
): Promise<string[]> {
  const requireNpm = createRequire(npm);
  const packageJson = requireNpm("@npmcli/package-json") as {
    normalize(path: string): Promise<{ content: Record<string, unknown> }>;
  };
  const packlist = requireNpm("npm-packlist") as (
    tree: unknown,
  ) => Promise<string[]>;
  const edgesOut = new Map(
    await Promise.all(
      [...closure].map(async ([name, { path }]) => {
        const { content } = await packageJson.normalize(path);
        const node = { path, package: content, edgesOut: new Map() };
        return [name, { to: { ...node, target: node } }] as const;
      }),
    ),
  );
  const { content } = await packageJson.normalize(hub);
  return (
    await packlist({
      path: hub,
      isProjectRoot: true,
      package: { ...content, bundleDependencies: [...closure.keys()] },
      edgesOut,
    })
  ).sort();
}

async function packReport(npm: string): Promise<string[]> {
  const cli = join(dirname(npm), "bin/npm-cli.js");
  const args = [cli, "pack", "--dry-run", "--json", "--ignore-scripts"];
  const result = await execFileAsync("node", args, {
    cwd: hub,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  }).catch(() => {
    throw new Error("npm pack inventory failed");
  });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm pack did not report JSON");
  }
  ok(Array.isArray(value) && value.length === 1, "Expected one packed package");
  const files = record(value[0]).files;
  ok(
    Array.isArray(files) && files.length > 0,
    "Expected nonempty pack inventory",
  );
  return files.map((entry) => {
    const path = record(entry).path;
    ok(typeof path === "string", "Expected a pack path");
    safePath(path);
    return path;
  });
}

function ownerOf(path: string): string | undefined {
  return [
    ...path.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+(?=\/)/g),
  ].at(-1)?.[0];
}

function checkInventory(
  paths: string[],
  expected: string[],
  closure: Map<string, Package>,
): void {
  const byPackage = new Map<string, string[]>();
  const own = [];
  for (const path of paths) {
    const match = ownerOf(path);
    if (match === undefined) own.push(path);
    else {
      const end = path.lastIndexOf(match) + match.length;
      const owner = path.slice(0, end);
      ok(
        closure.has(owner),
        "Pack contains a package outside the installed production closure",
      );
      const files = byPackage.get(owner) ?? [];
      files.push(path.slice(end + 1));
      byPackage.set(owner, files);
    }
  }
  ok(
    isDeepStrictEqual(own.sort(), ownFiles.toSorted()),
    "Unexpected hub own-file inventory",
  );
  for (const [owner, installed] of closure) {
    const files = byPackage.get(owner);
    ok(
      files !== undefined && files.includes("package.json"),
      "Pack omitted a production package",
    );
    runtimeTargets(installed.metadata, files);
    for (const name of installed.notices)
      ok(files.includes(name), "Pack omitted a bundled licence or notice file");
  }
  ok(
    isDeepStrictEqual(paths.toSorted(), expected),
    "Pack inventory differs from the packable installed files",
  );
}

const localPath =
  /(?:^|[\s"'(=;,])(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/[^/\s]+|\/root\/|~\/)/m;
const existingPackSecretShape =
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
const bundledContractSecretPrefixes = ["fh_", "fhk_"];
const bundledContractSecretPatterns = SECRET_PATTERNS.filter(({ source }) =>
  bundledContractSecretPrefixes.some((prefix) => source.startsWith(prefix)),
);

function hasSecretShape(text: string, owned: boolean): boolean {
  return (
    existingPackSecretShape.test(text) ||
    (owned ? SECRET_PATTERNS : bundledContractSecretPatterns).some((pattern) =>
      pattern.test(text),
    )
  );
}

type PackTextHit = "local path" | "token shape";

const allowedZodFixture = {
  path: "node_modules/zod/src/v4/mini/tests/string.test.ts",
  version: "4.6.7",
  sha256: "f4ebdab74387516508d0ce96a56979fe06af7e2425dccc13d34c0a229ba3a050",
  reason: "upstream zod test fixture string, not a credential",
};

function scanText(
  path: string,
  read: () => Buffer<ArrayBufferLike>,
  reject = (kind: PackTextHit, label: string): void => {
    throw new Error(kind + " in " + label);
  },
  zodVersion?: unknown,
): "scanned" | "allowlisted" | "binary" {
  safePath(path);
  const bytes = read();
  if (
    path === allowedZodFixture.path &&
    zodVersion === allowedZodFixture.version &&
    createHash("sha256").update(bytes).digest("hex") ===
      allowedZodFixture.sha256
  )
    return "allowlisted";
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  if (encoding === "utf-8" && bytes.includes(0)) return "binary";
  const text = new TextDecoder(encoding).decode(bytes);
  const owned = ownFiles.includes(path);
  const localPathHit = owned && localPath.test(text);
  const tokenHit = hasSecretShape(text, owned);
  if (localPathHit || tokenHit) {
    const label =
      localPath.test(path) || hasSecretShape(path, true)
        ? "[redacted path]"
        : JSON.stringify(path);
    if (localPathHit) reject("local path", label);
    if (tokenHit) reject("token shape", label);
  }
  return "scanned";
}

let packedPaths: Promise<string[]> | undefined;

test(
  "npm pack carries exactly the hub and its installed production closure",
  async () => {
    const npm = npmManifestPath();
    const version = node(["--version"], hub);
    const npmVersion = manifest(dirname(npm)).version;
    ok(
      version.status === 0 &&
        /^v\d+\.\d+\.\d+/.test(version.stdout) &&
        typeof npmVersion === "string" &&
        /^\d+\.\d+\.\d+/.test(npmVersion),
      "Expected Node and npm versions",
    );
    console.log(
      "Pack tools: Node %s, npm %s, Bun %s",
      version.stdout.trim(),
      npmVersion,
      Bun.version,
    );

    const manifestPath = join(hub, "package.json");
    const before = readFileSync(manifestPath);
    const started = performance.now();
    const closure = installedClosure();
    const closureMs = performance.now() - started;
    let packMs = 0;
    let packlistMs = 0;
    const [paths, expected] = await Promise.all([
      (packedPaths ??= packReport(npm)).then((files) => {
        packMs = performance.now() - started - closureMs;
        return files;
      }),
      packableFiles(npm, closure).then((files) => {
        packlistMs = performance.now() - started - closureMs;
        return files;
      }),
    ]);
    ok(
      before.equals(readFileSync(manifestPath)),
      "npm pack changed the hub manifest",
    );
    checkInventory(paths, expected, closure);

    const omitPackage = (owner: string) =>
      paths.filter((path) => !path.startsWith(owner + "/"));
    for (const mutation of [
      omitPackage("node_modules/chat"),
      omitPackage("node_modules/remark-parse"),
      paths.filter((path) => path !== "node_modules/chat/dist/index.js"),
      paths.filter((path) => path !== "dist/chat/telegram-wire.js"),
      [...paths, "node_modules/chat/node_modules/unrelated/package.json"],
    ]) {
      ok(
        mutation.length !== paths.length,
        "Synthetic inventory mutation did not apply",
      );
      expect(() => checkInventory(mutation, expected, closure)).toThrow();
    }
    for (const mutation of [
      paths.filter((path) => path !== "dist/contract/runtime.js"),
      [...paths, "dist/contract/placeholder.js"],
    ])
      expect(() => checkInventory(mutation, expected, closure)).toThrow(
        "Unexpected hub own-file inventory",
      );

    console.log(
      "A7 verified %d own files and %d bundled files in %d packages.",
      ownFiles.length,
      paths.length - ownFiles.length,
      closure.size,
    );
    console.log(
      "A7 phases: closure %d ms, npm pack %d ms, expected files %d ms.",
      Math.round(closureMs),
      Math.round(packMs),
      Math.round(packlistMs),
    );
  },
  timeout,
);

test(
  "packed text has no token shapes and owned text has no local paths",
  async () => {
    const paths = await (packedPaths ??= packReport(npmManifestPath()));
    const zodVersion = paths.includes(allowedZodFixture.path)
      ? manifest(join(hub, "node_modules/zod")).version
      : undefined;
    const hits: string[] = [];
    const hitCounts: Record<PackTextHit, number> = {
      "local path": 0,
      "token shape": 0,
    };
    const scanned = new Set<string>();
    let allowlisted = 0;
    for (const path of paths) {
      const result = scanText(
        path,
        () => readFileSync(join(hub, path)),
        (kind, label) => {
          hitCounts[kind]++;
          if (hits.length < 5) hits.push("A8 found " + kind + " in " + label);
        },
        zodVersion,
      );
      if (result === "scanned") scanned.add(path);
      if (result === "allowlisted") allowlisted++;
    }
    console.log(
      "A8 scanned %d packed text files and allowlisted %d. Hits: local path %d, token shape %d.",
      scanned.size,
      allowlisted,
      hitCounts["local path"],
      hitCounts["token shape"],
    );
    for (const hit of hits) console.error(hit);
    ok(
      ownFiles.every((path) => scanned.has(path)),
      "Pack scan must include all own text files",
    );
    ok(
      hitCounts["local path"] === 0 && hitCounts["token shape"] === 0,
      "Pack text contains a forbidden path or token shape",
    );
  },
  timeout,
);

test(
  "pack text scan scopes local paths to owned files and rejects token shapes",
  () => {
    const owned = "dist/main.js";
    const bundled = "node_modules/chat/dist/index.js";
    const homePath = Buffer.from("/home/" + "fixture/path");
    expect(() => scanText(owned, () => homePath)).toThrow("local path");
    expect(scanText(bundled, () => homePath)).toBe("scanned");
    expect(() =>
      scanText(owned, () => Buffer.from("Q:" + "\\Users\\fixture")),
    ).toThrow("local path");
    const fragments = ["gh", "p_", "a".repeat(36)];
    const forgeExamples = [
      ["f", "h_", "a".repeat(43)],
      ["f", "hk_", "a".repeat(43)],
    ];
    for (const parts of [
      ["xo", "xb-", "a".repeat(10)],
      ["xa", "pp-", "a".repeat(10)],
      ["gh", "p_", "a".repeat(30)],
      ["github", "_pat_", "a".repeat(30)],
      ["s", "k-", "a".repeat(20)],
      ["AK", "IA", "A".repeat(16)],
      ["-----BEGIN ", "PRIVATE KEY", "-----"],
      ["AS", "IA", "A".repeat(16)],
      ["ey", "J", "a".repeat(8), ".", "b".repeat(8), ".", "c".repeat(8)],
      ...forgeExamples,
    ])
      expect(() => scanText(owned, () => Buffer.from(parts.join("")))).toThrow(
        "token shape",
      );
    for (const parts of forgeExamples)
      expect(() =>
        scanText(bundled, () => Buffer.from(parts.join(""))),
      ).toThrow("token shape");
    expect(() =>
      scanText(
        allowedZodFixture.path,
        () => Buffer.from(fragments.join("")),
        undefined,
        allowedZodFixture.version,
      ),
    ).toThrow("token shape");
    for (const path of [owned, bundled]) {
      expect(() =>
        scanText(path, () => Buffer.from(fragments.join(""))),
      ).toThrow("token shape");
      expect(
        scanText(path, () => Buffer.from("https://example.test/path")),
      ).toBe("scanned");
    }
    for (const path of [".env", "node_modules/chat/.env"])
      expect(() =>
        scanText(path, () => {
          throw new Error("read");
        }),
      ).toThrow("Unsafe pack path");
  },
  timeout,
);

test(
  "pack text scan accepts contract-only vendor examples in integrity-pinned dependencies",
  () => {
    const vendorExample = ["s", "k-", "a".repeat(20)].join("");
    expect(
      scanText("node_modules/chat/dist/index.js", () =>
        Buffer.from(vendorExample),
      ),
    ).toBe("scanned");
  },
  timeout,
);
