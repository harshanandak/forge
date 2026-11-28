/// <reference types="bun" />

import { ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, test } from "bun:test";
import { hubTestTemp } from "./temp.ts";

const timeout = 30_000;
const hub = resolve(import.meta.dir, "..");
const root = resolve(hub, "..");
const dependencies = {
  chat: "4.45.0",
  "@chat-adapter/slack": "4.45.0",
  "@modelcontextprotocol/server": "2.3.1",
  "@modelcontextprotocol/node": "2.1.1",
  koffi: "3.3.3",
};
const fields = {
  name: "forge-hub",
  version: "0.0.0",
  private: true,
  license: "MIT",
  type: "module",
  engines: { node: ">=24.0.0" },
  bin: { "forge-hub": "bin/forge-hub.mjs" },
  files: [
    "bin",
    "dist",
    "manifests",
    "docs",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ],
};

function record(value: unknown): Record<string, unknown> {
  ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected a mapping",
  );
  return value as Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(path, "utf8")));
}

function checkPackage(pkg: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields))
    ok(
      isDeepStrictEqual(pkg[key], value),
      "Unexpected hub manifest field: " + key,
    );
  for (const key of [
    "scripts",
    "devDependencies",
    "peerDependencies",
    "publishConfig",
  ])
    ok(!Object.hasOwn(pkg, key), "Forbidden hub manifest field: " + key);
  ok(
    isDeepStrictEqual(pkg.dependencies, dependencies),
    "Hub dependencies must match the five exact pins",
  );
  ok(
    Array.isArray(pkg.bundleDependencies) &&
      isDeepStrictEqual(
        pkg.bundleDependencies.toSorted(),
        Object.keys(dependencies).sort(),
      ),
    "Hub bundle list must match the dependency names",
  );
}

test(
  "hub manifest pins the private package fields, dependencies and bundle list",
  () => {
    const pkg = readJson(join(hub, "package.json"));
    checkPackage(pkg);
    const noVersion = { ...pkg };
    delete noVersion.version;
    for (const mutation of [
      noVersion,
      { ...pkg, version: "invalid" },
      { ...pkg, private: false },
      { ...pkg, publishConfig: {} },
      { ...pkg, scripts: { postinstall: "unexpected" } },
      { ...pkg, files: fields.files.slice(1) },
      { ...pkg, dependencies: { ...dependencies, chat: "^4.45.0" } },
      { ...pkg, dependencies: { ...dependencies, extra: "1.0.0" } },
      { ...pkg, bundleDependencies: Object.keys(dependencies).slice(1) },
    ])
      expect(() => checkPackage(mutation)).toThrow();
  },
  timeout,
);

test(
  "hub license is a byte copy of the root license",
  () => {
    const copy = readFileSync(join(hub, "LICENSE"));
    ok(
      copy.equals(readFileSync(join(root, "LICENSE"))),
      "Hub license differs from the root",
    );
  },
  timeout,
);

const lf = (text: string): string => text.replace(/\r\n?/g, "\n");
const licences = {
  chat: "MIT",
  "@chat-adapter/slack": "MIT",
  "@modelcontextprotocol/server": "Apache-2.0",
  "@modelcontextprotocol/node": "Apache-2.0",
  koffi: "MIT",
};

test(
  "notices contain the full correctly labelled text of all five installed licences",
  () => {
    const noticePath = join(hub, "THIRD_PARTY_NOTICES.md");
    const actual = lf(readFileSync(noticePath, "utf8"));
    const sections = Object.entries(licences).map(([name, licence]) => {
      const installed = join(hub, "node_modules", name);
      const installedManifest = join(installed, "package.json");
      ok(existsSync(installedManifest), `Hub must install ${name} for notices`);
      const installedPackage = readJson(installedManifest);
      ok(
        installedPackage.version ===
          dependencies[name as keyof typeof dependencies] &&
          installedPackage.license === licence,
        "Installed notice source must match the pinned licence",
      );
      const licenseFile = name === "koffi" ? "LICENSE.txt" : "LICENSE";
      const text = lf(readFileSync(join(installed, licenseFile), "utf8"));
      ok(
        /^[ \t]*Copyright \(c\) /im.test(text),
        "Installed licence lacks its copyright notice",
      );
      return (
        "## " +
        name +
        "\n\n**Licence:** " +
        licence +
        "\n\n```text\n" +
        text +
        (text.endsWith("\n") ? "" : "\n") +
        "```"
      );
    });
    const expected =
      [
        "# Third-party notices",
        "Bundled transitive packages keep their own licence files inside the bundled `node_modules` folders.",
        "Koffi's MIT licence also covers the platform-specific prebuilds in the `@koromix/koffi-*` packages.",
        ...sections,
      ].join("\n\n") + "\n";
    const check = (notice: string) =>
      ok(
        notice === expected,
        "Hub third-party notices differ from installed licences",
      );
    check(actual);
    for (const mutation of [
      actual.replace(/^Permission is hereby granted[^\n]*\n(?:[^\n]+\n)*/m, ""),
      actual.replace(/^[ \t]*Copyright \(c\) [^\n]+\n/im, ""),
      actual.replace("**Licence:** Apache-2.0", "**Licence:** MIT"),
    ]) {
      ok(mutation !== actual, "The synthetic notice mutation did not apply");
      expect(() => check(mutation)).toThrow();
    }
  },
  timeout,
);

const scopes = [
  "chat:write",
  "im:write",
  "im:read",
  "im:history",
  "users:read",
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "chat:write.customize",
  "channels:read",
  "groups:read",
  "reactions:write",
  "canvases:write",
];
const events = [
  "app_mention",
  "message.im",
  "message.channels",
  "message.groups",
];

function checkList(value: unknown, expected: string[]): void {
  ok(
    Array.isArray(value) &&
      isDeepStrictEqual(value.toSorted(), expected.toSorted()),
    "Unexpected Slack manifest list",
  );
}

function checkSocketManifest(text: string): void {
  ok(
    !/request_url|connections:write|:\/\//i.test(text),
    "Forbidden entry in the socket manifest",
  );
  let document: unknown;
  try {
    document = Bun.YAML.parse(text);
  } catch {
    throw new Error("Invalid socket manifest YAML");
  }
  const { settings, oauth_config: oauthConfig } = record(document);
  const options = record(settings);
  ok(
    options.socket_mode_enabled === true &&
      options.token_rotation_enabled === false,
    "Unexpected Slack manifest settings",
  );
  checkList(record(record(oauthConfig).scopes).bot, scopes);
  checkList(record(options.event_subscriptions).bot_events, events);
}

test(
  "socket manifest has only the expected bot scopes and events",
  () => {
    const manifest = readFileSync(
      join(hub, "manifests/slack-socket.yaml"),
      "utf8",
    );
    checkSocketManifest(manifest);
    for (const mutation of [
      manifest + "request_url: https://example.test\n",
      manifest.replace("      - canvases:write\n", ""),
      manifest.replace("      - channels:read\n", ""),
      manifest.replace("      - groups:read\n", ""),
      manifest.replace(
        "      - canvases:write\n",
        "      - canvases:write\n      - canvases:write\n",
      ),
    ])
      expect(() => checkSocketManifest(mutation)).toThrow();
  },
  timeout,
);

function checkTypecheckWiring(
  rootConfig: Record<string, unknown>,
  hubConfig: Record<string, unknown>,
  scripts: Record<string, unknown>,
): void {
  ok(
    Array.isArray(rootConfig.include) && rootConfig.include.includes("hub"),
    "Root typecheck must include hub",
  );
  ok(
    Array.isArray(hubConfig.include) && hubConfig.include.includes("src"),
    "Hub build must include its source",
  );
  ok(
    scripts.check === "bun check" &&
      scripts["build:hub"] === "tsc -p hub/tsconfig.json",
    "Unexpected typecheck command",
  );
}

function probeConfig(parent: string): void {
  const cwd = hubTestTemp("forge-hub-typecheck-");
  try {
    const config = join(cwd, "tsconfig.json");
    writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      config,
      JSON.stringify({
        extends: parent,
        files: ["probe.ts"],
        include: [],
        exclude: [],
        compilerOptions: {
          types: [],
          paths: {},
          rootDir: ".",
          outDir: "./out",
          noEmit: true,
        },
      }),
    );
    const compile = (value: string) => {
      writeFileSync(
        join(cwd, "probe.ts"),
        "export const probe: number = " + value + ";\n",
      );
      return spawnSync(
        process.execPath,
        [
          join(root, "node_modules/typescript/bin/tsc"),
          "--pretty",
          "false",
          "-p",
          config,
        ],
        { cwd, encoding: "utf8", windowsHide: true },
      );
    };
    expect(compile("1").status).toBe(0);
    const bad = compile('"wrong"');
    ok(
      bad.status !== null && bad.status !== 0,
      "Compiler must refuse a wrong assignment",
    );
    ok(
      /probe\.ts.*TS2322: Type .* is not assignable to type 'number'/m.test(
        bad.stdout + bad.stderr,
      ),
      "Compiler must identify the bad probe assignment",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test(
  "root and hub typecheck wiring rejects type errors",
  () => {
    const rootConfigPath = join(root, "tsconfig.json");
    const hubConfigPath = join(hub, "tsconfig.json");
    const rootConfig = readJson(rootConfigPath);
    const hubConfig = readJson(hubConfigPath);
    const scripts = record(readJson(join(root, "package.json")).scripts);
    checkTypecheckWiring(rootConfig, hubConfig, scripts);
    expect(() =>
      checkTypecheckWiring({ ...rootConfig, include: [] }, hubConfig, scripts),
    ).toThrow();
    expect(() =>
      checkTypecheckWiring(rootConfig, hubConfig, {
        ...scripts,
        "build:hub": "tsc",
      }),
    ).toThrow();
    probeConfig(rootConfigPath);
    probeConfig(hubConfigPath);
  },
  timeout,
);
