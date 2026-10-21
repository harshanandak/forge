import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import { counterfactuals } from "../node-fixtures/check/counterfactuals.ts";

test("unknown commands retain exit 3 unless configuration hides a declared operation", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-unknown-config-"));
  const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
  const cli = (args: string[], code: number) => {
    const result = spawnSync("node", [bin, ...args], {
      cwd: root,
      env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(code);
    return result.stdout;
  };
  const unknown = (args: string[], suggest?: string) => {
    const result = JSON.parse(cli(args, 3)) as ResultEnvelope;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
    if (result.ok) throw Error("Expected unknown command");
    expect(result.error.message).toBe(
      `Unknown operation: ${args[0]}.${args[1] ?? ""}`,
    );
    if (suggest) expect(result.error.suggest).toContain(suggest);
  };
  try {
    unknown(["unknown-command"]);
    mkdirSync(join(root, ".forge"));
    const file = join(root, ".forge/config.yaml");
    writeFileSync(file, "blocks:\n  check:\n    commands: {}\n");
    unknown(["check", "lst"], "check.list");
    unknown(["unknown-command"]);
    const text = cli(["check", "lst", "--text"], 3);
    expect(text).toContain("Unknown operation: check.lst");
    expect(text).toContain("check.list");
    writeFileSync(
      file,
      "blocks:\n  check:\n    commands: {}\n    timoutMs: 3000\n",
    );
    unknown(["check", "lst"]);
    unknown(["unknown-command"]);
    const hidden = JSON.parse(cli(["check", "list"], 6)) as ResultEnvelope;
    if (hidden.ok) throw Error("Expected invalid config");
    expect(hidden.error.message).toContain(".forge/config.yaml");
    expect(hidden.error.message).toContain("blocks.check.config.timoutMs");
    expect(hidden.error.message).toContain("did you mean timeoutMs?");
    writeFileSync(
      file,
      JSON.stringify({
        blocks: {
          unrelated: { source: { path: "./missing-block" } },
          check: { commands: {}, timoutMs: 3000 },
        },
      }),
    );
    expect(JSON.parse(cli(["check", "list"], 6))).toMatchObject({
      error: { code: "INPUT_INVALID" },
    });
    writeFileSync(file, "blocks:\n  memory:\n    typo: true\n");
    unknown(["check", "list"]);
    writeFileSync(file, "blocks: {}\nmcp: false\n");
    unknown(["check", "list"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 110_000);

test("built CLI reports the actual config error and recovers after repair", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-config-errors-cli-"));
  const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
  mkdirSync(join(root, ".forge"));
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  expect(initialized.status, initialized.stderr).toBe(0);
  const file = join(root, ".forge/config.yaml");
  const cli = (args: string[], code: number): ResultEnvelope => {
    const result = spawnSync("node", [bin, ...args], {
      cwd: root,
      env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(code);
    return JSON.parse(result.stdout) as ResultEnvelope;
  };
  try {
    for (const [name, config, key, fix] of [
      [
        "typo",
        { timoutMs: 3000 },
        "blocks.check.config.timoutMs",
        "did you mean timeoutMs?",
      ],
      [
        "type",
        { timeoutMs: "soon" },
        "blocks.check.config.timeoutMs",
        "a valid integer",
      ],
      [
        "source",
        { source: { builtin: "forge/chekc" } },
        "blocks.check.source.builtin",
        'use "forge/check"',
      ],
      ["yaml", "blocks: [\n", "strict YAML", "Fix:"],
      [
        "quote",
        { commands: { test: 'tool "unterminated' } },
        "blocks.check.config.commands.test",
        '{"argv":["tool","unterminated"]}',
      ],
      [
        "shell",
        { commands: { test: "tool && other" } },
        "blocks.check.config.commands.test",
        '{"argv":["tool","&&","other"]}',
      ],
    ] as const) {
      writeFileSync(
        file,
        typeof config === "string"
          ? config
          : JSON.stringify({
              blocks: { check: { commands: {}, ...config }, memory: {} },
            }),
      );
      const shown = cli(["config", "show"], 6);
      expect(shown).toMatchObject({ ok: false, result: { valid: false } });
      const called = cli(["check", "list"], 6);
      if (shown.ok || called.ok) throw Error("Expected invalid config");
      expect(called.error.message).toBe(shown.error.message);
      expect(called.error.message).toContain(key);
      expect(called.error.message).toContain(fix);
      if (name === "yaml") expect(called.error.message).toContain("blocks: [");
      const text = spawnSync("node", [bin, "check", "list", "--text"], {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      expect(text.status).toBe(6);
      console.log(`${name} (exit 6):\n${text.stdout}`);
      if (name !== "yaml")
        expect(cli(["memory", "search", "audit"], 0).ok).toBe(true);
    }
    writeFileSync(
      file,
      JSON.stringify({
        blocks: {
          verify: {
            source: { builtin: "forge/check" },
            rename: { check: "verify" },
            commands: { test: 'tool "unterminated' },
          },
        },
      }),
    );
    const aliased = cli(["verify", "run"], 6);
    if (aliased.ok) throw Error("Expected invalid command");
    expect(aliased.error.message).toContain(
      "blocks.verify.config.commands.test",
    );
    writeFileSync(file, "blocks:\n  check:\n    commands: {}\n");
    expect(cli(["config", "show"], 0)).toMatchObject({
      ok: true,
      result: { valid: true },
    });
    expect(cli(["check", "list"], 0)).toMatchObject({
      ok: true,
      result: { commands: [] },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 110_000);

test("config show reports unavailable trust before invalid config and recovers its verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-config-trust-errors-"));
  const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
  const deviceRoot = join(root, "device");
  const storePath = join(deviceRoot, "trust.sqlite");
  mkdirSync(join(root, ".forge"));
  mkdirSync(storePath, { recursive: true });
  const cli = (args: string[], code: number) => {
    const result = spawnSync("node", [bin, ...args], {
      cwd: root,
      env: { ...process.env, FORGE_DEVICE_ROOT: deviceRoot },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(code);
    expect(result.stderr).toBe("");
    return result.stdout;
  };
  try {
    for (const config of [
      "blocks:\n  check:\n    commands: {}\n    timoutMs: 3000\n",
      "blocks: [\n",
    ]) {
      writeFileSync(join(root, ".forge/config.yaml"), config);
      expect(cli(["--help"], 0)).toStartWith("Usage: forge");
      for (const args of [
        ["config", "detect"],
        ["catalog", "list"],
        ["catalog", "describe", "config.show"],
        ["template", "list"],
      ])
        expect(JSON.parse(cli(args, 0))).toMatchObject({ ok: true });
      const unknown = JSON.parse(cli(["config", "shwo"], 3)) as ResultEnvelope;
      expect(unknown).toMatchObject({
        ok: false,
        error: { code: "UNKNOWN_COMMAND" },
      });
      if (unknown.ok) throw Error("Expected unknown command");
      expect(unknown.error.suggest).toContain("config.show");
      expect(JSON.parse(cli(["check", "list"], 6))).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      const unavailable = JSON.parse(
        cli(["config", "show"], 1),
      ) as ResultEnvelope;
      expect(unavailable).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retry: "never" },
      });
      if (unavailable.ok) throw Error("Expected unavailable trust store");
      expect(unavailable.error.message).toContain(storePath);
      expect(unavailable.error.message).toContain(
        "is a directory, expected the Forge store file; move or delete it",
      );
      expect(unavailable).not.toHaveProperty("result");
      rmSync(storePath, { recursive: true });
      expect(JSON.parse(cli(["config", "show"], 6))).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
        result: { valid: false },
      });
      mkdirSync(storePath);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 110_000);

test("affected check counterfactuals still fail on the built artifact", () => {
  const repo = resolve(import.meta.dirname, "../..");
  const root = mkdtempSync(join(tmpdir(), "forge-config-counterfactual-"));
  try {
    cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true });
    cpSync(join(repo, "templates"), join(root, "templates"), {
      recursive: true,
    });
    cpSync(join(repo, "package.json"), join(root, "package.json"));
    symlinkSync(
      join(repo, "node_modules"),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const mutations = counterfactuals.filter(
      (mutation) =>
        mutation.from.startsWith("function commandArguments") ||
        mutation.evidence === "check list:",
    );
    expect(mutations).toHaveLength(3);
    mkdirSync(join(root, ".forge"));
    const call = (parser: boolean) =>
      spawnSync(
        "node",
        [
          join(root, "dist/bin/forge.js"),
          ...(parser ? ["check", "run"] : ["config", "show"]),
        ],
        {
          cwd: root,
          env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
    for (const mutation of mutations) {
      const parser = mutation.from.startsWith("function commandArguments");
      writeFileSync(
        join(root, ".forge/config.yaml"),
        JSON.stringify({
          blocks: {
            check: {
              commands: { test: parser ? 'tool "unterminated' : "tool" },
            },
          },
        }),
      );
      const baseline = call(parser);
      expect(baseline.error).toBeUndefined();
      expect(baseline.status, baseline.stdout + baseline.stderr).toBe(
        parser ? 6 : 0,
      );
      expect(JSON.parse(baseline.stdout)).toMatchObject(
        parser
          ? { ok: false, error: { code: "INPUT_INVALID" } }
          : { ok: true, result: { valid: true } },
      );
      const file = join(root, "dist/src", mutation.file);
      const original = readFileSync(file, "utf8");
      expect(original.split(mutation.from)).toHaveLength(2);
      writeFileSync(file, original.replace(mutation.from, mutation.to));
      try {
        const result = call(parser);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(
          parser ? 1 : 6,
        );
        expect(JSON.parse(result.stdout)).toMatchObject(
          parser
            ? { ok: false, error: { code: "PROVIDER_MISSING" } }
            : { ok: false, result: { valid: false } },
        );
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 110_000);
