/// <reference types="bun" />

import { ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
import { isDeepStrictEqual } from "node:util";
import { expect, test } from "bun:test";

const timeout = 30_000;
const hub = realpathSync(resolve(import.meta.dir, ".."));
const bin = join(hub, "bin/forge-hub.mjs");
const dist = join(hub, "dist");
const mainUrl = pathToFileURL(join(dist, "main.js")).href;
const setupUrl = pathToFileURL(join(dist, "setup/index.js")).href;
const usage = "usage: forge-hub <command>\n";

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
  const cwd = mkdtempSync(join(tmpdir(), "forge-hub-cli-"));
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
      isolatedNode(args, 2, "", usage);
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

const importGuard = `
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import { readFileSync } from "node:fs";
  import promises from "node:fs/promises";
  import http from "node:http";
  import { registerHooks, syncBuiltinESMExports } from "node:module";
  const loadFile = fs.readFileSync;
  const root = new URL(".", process.argv[1]).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(root) && url.endsWith(".js")) {
        return { format: "module", shortCircuit: true, source: loadFile(new URL(url)) };
      }
      return nextLoad(url, context);
    },
  });
  const deny = () => { throw new Error("blocked import effect"); };
  for (const name of ["fs", "fs/promises", "http", "https", "net", "tls", "dns", "dns/promises", "dgram", "http2"]) {
    const module = process.getBuiltinModule(name);
    for (const key of Object.keys(module)) {
      if (typeof module[key] === "function") module[key] = deny;
    }
  }
  for (const key of ["fetch", "WebSocket", "EventSource"])
    Object.defineProperty(globalThis, key, { value: deny, configurable: true });
  process.chdir = deny;
  process.env = new Proxy({}, { get: deny, set: deny, has: deny, ownKeys: deny });
  syncBuiltinESMExports();
  Object.defineProperty(process, "env", { get: deny, set: deny });
  for (const effect of [
    () => fs.readFileSync("missing"),
    () => readFileSync("missing"),
    () => fs.writeFileSync("unexpected", ""),
    () => promises.readdir("."),
    () => process.chdir("."),
    () => process.env.FORGE_HUB_CONFIG,
    () => http.get("http://127.0.0.1"),
    () => fetch("http://127.0.0.1"),
    () => new WebSocket("ws://127.0.0.1"),
  ]) assert.throws(effect, /blocked import effect/);
  await import(process.argv[2]);
`;

test(
  "application modules import without filesystem, environment or network work",
  () => {
    for (const url of [mainUrl, setupUrl])
      isolatedNode(
        ["--input-type=module", "-e", importGuard, mainUrl, url],
        0,
        "",
        "",
      );
  },
  timeout,
);

const ownFiles = [
  "package.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "bin/forge-hub.mjs",
  "manifests/slack-socket.yaml",
  "dist/main.js",
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
type Package = { path: string; metadata: Record<string, unknown> };

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
        closure.set(key, { path, metadata: installed });
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
    metadata.main,
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

async function packableFiles(npm: string): Promise<string[]> {
  const requireNpm = createRequire(npm);
  const Arborist = requireNpm("@npmcli/arborist") as new (options: {
    path: string;
  }) => { loadActual(): Promise<unknown> };
  const packlist = requireNpm("npm-packlist") as (
    tree: unknown,
  ) => Promise<string[]>;
  return packlist(await new Arborist({ path: hub }).loadActual());
}

function packReport(): string[] {
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const options = {
    cwd: hub,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  } as const;
  const result =
    process.platform === "win32"
      ? spawnSync(
          "cmd.exe",
          ["/d", "/s", "/c", "npm " + args.join(" ")],
          options,
        )
      : spawnSync("npm", args, options);
  ok(result.status === 0, "npm pack inventory failed");
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
    for (const name of readdirSync(installed.path).filter((name) =>
      /^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(name),
    ))
      ok(files.includes(name), "Pack omitted a bundled licence or notice file");
  }
  ok(
    isDeepStrictEqual(paths.toSorted(), expected.toSorted()),
    "Pack inventory differs from the packable installed files",
  );
}

const localPath =
  /(?:^|[\s"'(=;,])(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/[^/\s]+|\/root\/|~\/)/m;
const secretShape =
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;

function scanText(path: string, read: () => Buffer<ArrayBufferLike>): boolean {
  safePath(path);
  const bytes = read();
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  if (encoding === "utf-8" && bytes.includes(0)) return false;
  const text = new TextDecoder(encoding).decode(bytes);
  ok(
    !localPath.test(text) && !secretShape.test(text),
    "Pack text contains a forbidden path or token shape",
  );
  return true;
}

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
    const paths = packReport();
    ok(
      before.equals(readFileSync(manifestPath)),
      "npm pack changed the hub manifest",
    );
    const closure = installedClosure();
    const expected = await packableFiles(npm);
    checkInventory(paths, expected, closure);

    const omitPackage = (owner: string) =>
      paths.filter((path) => !path.startsWith(owner + "/"));
    for (const mutation of [
      omitPackage("node_modules/chat"),
      omitPackage("node_modules/remark-parse"),
      paths.filter((path) => path !== "node_modules/chat/dist/index.js"),
      [...paths, "node_modules/chat/node_modules/unrelated/package.json"],
    ]) {
      ok(
        mutation.length !== paths.length,
        "Synthetic inventory mutation did not apply",
      );
      expect(() => checkInventory(mutation, expected, closure)).toThrow();
    }

    const scanned = new Set(
      paths.filter((path) =>
        scanText(path, () => readFileSync(join(hub, path))),
      ),
    );
    ok(
      ownFiles.every((path) => scanned.has(path)),
      "Pack scan must include all own text files",
    );
    console.log(
      "Packed %d own files and %d bundled files in %d packages. Scanned %d text files.",
      ownFiles.length,
      paths.length - ownFiles.length,
      closure.size,
      scanned.size,
    );
  },
  timeout,
);

test(
  "pack text scan refuses local paths and token shapes before reporting counts",
  () => {
    const fragments = ["gh", "p_", "a".repeat(36)];
    for (const path of ["dist/main.js", "node_modules/chat/dist/index.js"]) {
      for (const text of [
        "Q:" + "\\Users\\fixture",
        "/home/" + "fixture/path",
        fragments.join(""),
      ])
        expect(() => scanText(path, () => Buffer.from(text))).toThrow();
      expect(
        scanText(path, () => Buffer.from("https://example.test/path")),
      ).toBe(true);
    }
    expect(() =>
      scanText(".env", () => {
        throw new Error("read");
      }),
    ).toThrow("Unsafe pack path");
  },
  timeout,
);
