import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  FailureEnvelope,
  ResultEnvelope,
  UpgradeHint,
} from "../../src/generated/types.ts";
import { counterfactuals } from "../node-fixtures/check/counterfactuals.ts";
import { localUpgradeCommand } from "../../src/adapters/node-runtime/catalog.ts";
import { pathToFileURL } from "node:url";
import { GENERATED_MARKER, renderSkills } from "../../src/surface/skills.ts";
import { version } from "../../src/version.ts";
import { candidate } from "../surface/fixtures/catalog.ts";
import { removeQuietly, spawnBudget } from "../spawn-budget.ts";

type HintedFailure = FailureEnvelope & {
  readonly error: FailureEnvelope["error"] & {
    readonly hint: UpgradeHint & {
      readonly cwd: string;
      readonly running: UpgradeHint["running"] & { readonly commit: string };
    };
  };
};

const futureSkill = (
  op: string,
  block = "forge/check",
  version = "999.0.0",
): string =>
  `${GENERATED_MARKER}\n<!-- forge version: ${version} -->\n<!-- forge block: ${block} -->\n## \`${op}\`\n`;

test("source repair keeps shell syntax in cwd data and emits a fixed command", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-repair-"));
  try {
    const checkout = join(root, "$(calc) ` ' forge");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const repair = localUpgradeCommand(pathToFileURL(checkout), version);
    expect(repair).toEqual({
      cwd: checkout,
      command: "bun install --frozen-lockfile && bun run build",
    });
    expect(repair.command).not.toContain("$(calc)");
    const local = join(root, "consumer", "node_modules", "forge-workflow");
    expect(localUpgradeCommand(pathToFileURL(local), version)).toEqual({
      cwd: join(root, "consumer"),
      command: "npm install --save-dev forge-workflow@beta",
    });
    expect(
      localUpgradeCommand(pathToFileURL(join(root, "installed")), "1.0.0"),
    ).toEqual({
      cwd: null,
      command: "npm install --global forge-workflow@latest",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("generated builtin skills record the generator version and block provenance", () => {
  const skill =
    renderSkills([
      { ...candidate("check.future"), blockId: "forge/check", builtin: true },
    ])[0]?.text ?? "";
  expect(skill).toContain(`<!-- forge version: ${version} -->`);
  expect(skill).toContain("<!-- forge block: forge/check -->");
  expect(
    renderSkills([
      { ...candidate("check.future"), blockId: "forge/check", builtin: false },
    ])[0]?.text,
  ).not.toContain("<!-- forge block:");
}, 30_000);

test("repo-declared missing operations carry a build hint while unknown names stay plain", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-stale-command-"));
  const repo = resolve(import.meta.dirname, "../..");
  const privateBuild = join(root, "build");
  const privateBin = join(privateBuild, "dist/bin/forge.js");
  function invokePrivateCli(args: string[], status: number): string {
    const result = spawnSync("node", [privateBin, ...args], {
      cwd: root,
      env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return result.stdout;
  }
  try {
    cpSync(join(repo, "dist"), join(privateBuild, "dist"), { recursive: true });
    cpSync(join(repo, "templates"), join(privateBuild, "templates"), {
      recursive: true,
    });
    cpSync(join(repo, "package.json"), join(privateBuild, "package.json"));
    symlinkSync(
      join(repo, "node_modules"),
      join(privateBuild, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    mkdirSync(join(privateBuild, ".git"));
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "blocks:\n  check:\n    commands: {}\n",
    );
    mkdirSync(join(root, ".agents/skills/check"), { recursive: true });
    const privateSkillFile = join(root, ".agents/skills/check/SKILL.md");
    writeFileSync(privateSkillFile, futureSkill("check.future"));
    const missing = JSON.parse(
      invokePrivateCli(["check", "future"], 3),
    ) as HintedFailure;
    expect(typeof missing.error.hint.command).toBe("string");
    // Bun's asymmetric object matcher replaces fields on its received object.
    expect(structuredClone(missing)).toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_COMMAND",
        retry: "never",
        message: "Unknown operation: check.future",
        hint: {
          running: {
            version: expect.any(String) as unknown,
            commit: expect.stringMatching(/^[a-f0-9]{40}$/) as unknown,
            dirty: expect.any(Boolean) as unknown,
          },
          required: expect.stringContaining("check.future") as unknown,
          cwd: realpathSync(privateBuild),
          command: expect.stringContaining(
            "bun install --frozen-lockfile && bun run build",
          ) as unknown,
        },
      },
    });
    expect(missing.error.hint.command).toBe(
      "bun install --frozen-lockfile && bun run build",
    );
    expect(missing.error.hint.cwd).toContain(realpathSync(privateBuild));
    const text = invokePrivateCli(["check", "future", "--text"], 3);
    expect(text).toContain("Unknown operation: check.future");
    expect(
      text.split("\n").filter((line) => line.includes("bun install")),
    ).toHaveLength(1);
    expect(text).toContain(missing.error.hint.running.commit);
    expect(
      (
        JSON.parse(invokePrivateCli(["check", "unmentioned"], 3)) as {
          error: unknown;
        }
      ).error,
    ).not.toHaveProperty("hint");
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "blocks:\n  check:\n    enabled: false\n",
    );
    writeFileSync(
      privateSkillFile,
      "<!-- Generated by forge skills sync from the catalog; edits are overwritten. -->\n## `check.list`\n",
    );
    expect(
      (JSON.parse(invokePrivateCli(["check", "list"], 3)) as { error: unknown })
        .error,
    ).not.toHaveProperty("hint");
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "blocks:\n  check:\n    commands: {}\n",
    );
    writeFileSync(privateSkillFile, "## `check.future`\n");
    expect(
      (
        JSON.parse(invokePrivateCli(["check", "future"], 3)) as {
          error: unknown;
        }
      ).error,
    ).not.toHaveProperty("hint");
    for (const evidence of [
      futureSkill("check.future", "custom/check"),
      futureSkill("check.future", "forge/check", version),
      `${GENERATED_MARKER}\n## \`check.future\`\n`,
    ]) {
      writeFileSync(privateSkillFile, evidence);
      expect(
        (
          JSON.parse(invokePrivateCli(["check", "future"], 3)) as {
            error: unknown;
          }
        ).error,
      ).not.toHaveProperty("hint");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 110_000);

test("a retained newer skill cannot suggest rebuilding an operation exposed under a config rename", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-renamed-hint-"));
  try {
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      JSON.stringify({
        blocks: {
          check: {
            source: { builtin: "forge/check" },
            rename: { check: "verify" },
            config: { commands: {} },
          },
        },
      }),
    );
    mkdirSync(join(root, ".agents/skills/check"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/check/SKILL.md"),
      futureSkill("check.run"),
    );
    const result = spawnSync(
      "node",
      [resolve(import.meta.dirname, "../../dist/bin/forge.js"), "check", "run"],
      {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(3);
    const envelope = JSON.parse(result.stdout) as FailureEnvelope;
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "UNKNOWN_COMMAND",
        message: "Unknown operation: check.run",
        retry: "never",
      },
    });
    expect(envelope.error).not.toHaveProperty("hint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("newer generated skills for disabled builtin and custom blocks do not suggest rebuilding", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-disabled-hint-"));
  try {
    mkdirSync(join(root, ".forge"));
    mkdirSync(join(root, ".agents/skills/check"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/check/SKILL.md"),
      futureSkill("check.future"),
    );
    for (const source of [
      { builtin: "forge/check" },
      { path: "./removed-custom" },
    ]) {
      writeFileSync(
        join(root, ".forge/config.yaml"),
        JSON.stringify({ blocks: { check: { source, enabled: false } } }),
      );
      const result = spawnSync(
        "node",
        [
          resolve(import.meta.dirname, "../../dist/bin/forge.js"),
          "check",
          "future",
        ],
        {
          cwd: root,
          env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(3);
      const envelope = JSON.parse(result.stdout) as { error: unknown };
      expect(envelope).toMatchObject({
        ok: false,
        error: { code: "UNKNOWN_COMMAND" },
      });
      expect(envelope.error).not.toHaveProperty("hint");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("packaged builds keep their identity and offer a package upgrade without runtime git", () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const repo = resolve(import.meta.dirname, "../..");
  const root = mkdtempSync(join(tmpdir(), "forge-stale-package-"));
  try {
    const installed = join(root, "installed");
    cpSync(join(repo, "dist"), join(installed, "dist"), { recursive: true });
    cpSync(join(repo, "templates"), join(installed, "templates"), {
      recursive: true,
    });
    cpSync(join(repo, "package.json"), join(installed, "package.json"));
    symlinkSync(
      join(repo, "node_modules"),
      join(installed, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "blocks:\n  check:\n    commands: {}\n",
    );
    mkdirSync(join(root, ".agents/skills/check"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/check/SKILL.md"),
      futureSkill("check.future"),
    );
    const result = spawnSync(
      node,
      [join(installed, "dist/bin/forge.js"), "check", "future"],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: "",
          FORGE_DEVICE_ROOT: join(root, "device"),
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      error: {
        code: "UNKNOWN_COMMAND",
        hint: {
          running: JSON.parse(
            readFileSync(join(installed, "dist/build.json"), "utf8"),
          ) as unknown,
          required: expect.stringContaining("check.future") as unknown,
          cwd: null,
          command: "npm install --global forge-workflow@beta",
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("unknown config keys without positive version evidence retain a plain warning", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-stale-config-"));
  try {
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      "blocks:\n  check:\n    commands: {}\n    futureOption: true\n",
    );
    const result = spawnSync(
      "node",
      [
        resolve(import.meta.dirname, "../../dist/bin/forge.js"),
        "config",
        "show",
      ],
      {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as ResultEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings as readonly unknown[]).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_KEY_IGNORED",
      }),
    );
    expect(
      envelope.warnings.find(({ code }) => code === "CONFIG_KEY_IGNORED"),
    ).not.toHaveProperty("hint");
    expect(readFileSync(join(root, ".forge/config.yaml"), "utf8")).toContain(
      "futureOption: true",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

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
  const budget = spawnBudget(110_000);
  budget.run("git init", "git", ["init", "--quiet"], { cwd: root }, 0);
  const file = join(root, ".forge/config.yaml");
  const cli = (args: string[], code: number): ResultEnvelope => {
    const result = budget.run(
      `forge ${args.join(" ")}`,
      "node",
      [bin, ...args],
      {
        cwd: root,
        env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
      },
      code,
    );
    return JSON.parse(result.stdout) as ResultEnvelope;
  };
  try {
    for (const [name, config, key, fix] of [
      [
        "timeout typo",
        { operationTimeouts: { "check.rnu": 3000 } },
        'blocks.check.operationTimeouts["check.rnu"]',
        "did you mean check.run?",
      ],
      [
        "timeout from unbound block",
        { operationTimeouts: { "memory.search": 3000 } },
        'blocks.check.operationTimeouts["memory.search"]',
        "block is not bound",
      ],
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
    writeFileSync(
      file,
      JSON.stringify({
        blocks: {
          verify: {
            source: { builtin: "forge/chekc" },
            rename: { check: "verify" },
            commands: {},
          },
        },
      }),
    );
    const mistypedAlias = cli(["verify", "run"], 6);
    if (mistypedAlias.ok) throw Error("Expected invalid builtin");
    expect(mistypedAlias.error.message).toContain(
      "blocks.verify.source.builtin:",
    );
    expect(mistypedAlias.error.message).toContain(
      'got "forge/chekc". Fix: use "forge/check".',
    );
    cli(["verify", "rn"], 3);
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
    removeQuietly(root);
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
