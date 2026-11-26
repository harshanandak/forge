import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const installed = process.argv[2];
const bin = join(installed, "dist/bin/forge.js");
// Supplemental: public config detect omits ignored values and source files; public assertions are separate.
const { detectProject, createFolderFiles } = await import(
  pathToFileURL(join(installed, "dist/src/blocks/project/index.js"))
);
function snapshot(root) {
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root, { recursive: true }).map((file) => {
      const path = join(root, file);
      const stat = statSync(path);
      return [
        file,
        {
          ...(stat.isDirectory()
            ? { directory: true }
            : {
                hash: createHash("sha256")
                  .update(readFileSync(path))
                  .digest("hex"),
              }),
          ...(process.platform === "win32" ? {} : { mode: stat.mode }),
        },
      ];
    }),
  );
}

for (const ecosystem of ["pnpm", "python", "npm"]) {
  const started = performance.now();
  const root = join(process.cwd(), ecosystem);
  const sandbox = join(process.cwd(), `${ecosystem}-sandbox`);
  const device = join(sandbox, "device");
  mkdirSync(root);
  mkdirSync(sandbox);
  const env = { ...process.env };
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
  ]) {
    env[key] = join(sandbox, key.toLowerCase());
    mkdirSync(env[key]);
  }
  env.FORGE_DEVICE_ROOT = device;
  const run = (executable, args) => {
    const result = spawnSync(executable, args, {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `${args.join(" ")}: ${result.stdout} ${result.stderr}`,
    );
    return result.stdout;
  };
  const write = (file, bytes) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  run("git", ["init", "--quiet"]);
  const python = ecosystem === "python";
  const pnpm = ecosystem === "pnpm";
  const manager = pnpm ? "husky" : "lefthook";
  const hook = pnpm ? ".husky/pre-commit" : ".git/hooks/pre-commit";
  const hookBytes = pnpm
    ? "#!/bin/sh\npnpm test\n"
    : '#!/bin/sh\nexec lefthook run pre-commit "$@"\n';
  if (python) {
    write("pyproject.toml", '[project]\nname = "fixture"\nversion = "0.0.0"\n');
    write(
      "lefthook.yml",
      "pre-commit:\n  commands:\n    tests:\n      run: python -m unittest\n",
    );
  } else {
    write(
      "package.json",
      JSON.stringify({
        packageManager: `${ecosystem}@10.0.0`,
        ...(pnpm
          ? { scripts: { test: "node test.js", prepare: "husky" } }
          : { devDependencies: { vitest: "3.0.0" } }),
      }),
    );
    if (pnpm) write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  }
  if (ecosystem !== "npm") {
    write(hook, hookBytes);
    if (process.platform !== "win32") chmodSync(join(root, hook), 0o755);
  }
  const before = snapshot(root);
  const sandboxBefore = snapshot(sandbox);
  assert.ok(before[join(".git", "config")]);
  const cli = (args) =>
    JSON.parse(run(process.execPath, [bin, ...args])).result;
  run(process.execPath, [bin, "--version"]);
  run(process.execPath, [bin, "--help"]);
  const show = cli(["config", "show"]);
  assert.equal(show.configured, false);
  assert.equal(show.valid, true);
  assert.deepEqual(show.templates, []);
  // Memory is the only built-in instance: no workflow, gate, hook or rail is enabled.
  assert.deepEqual(show.instances, [
    { name: "memory", source: { builtin: "forge/memory" }, enabled: true },
  ]);
  assert.deepEqual(show.effective, {
    blocks: {
      memory: {
        source: { builtin: "forge/memory" },
        config: { levels: { human: "nearest", agent: "required" } },
      },
    },
  });
  const detection = cli(["config", "detect"]);
  const report = detectProject(createFolderFiles(root));
  assert.deepEqual(report.failures, []);
  const key = `/blocks/project/detected/${python ? "python/present" : "node/packageManager"}`;
  const fact = report.observations.find((entry) => entry.key === key);
  assert.deepEqual(
    fact.value,
    python ? true : { name: ecosystem, version: "10.0.0" },
  );
  assert.equal(fact.origin.detector, "project.detect");
  assert.equal(fact.origin.file, python ? "pyproject.toml" : "package.json");
  if (!python) assert.equal(fact.origin.pointer, "/packageManager");
  const ignored = detection.ignored
    .filter((entry) => entry.detector === "project.detect")
    .map((entry) => entry.key);
  assert.ok(ignored.includes(key));
  assert.ok(
    ignored.includes(
      `/blocks/project/detected/${ecosystem === "npm" ? "node/testRunners/vitest" : `hooks/managers/${manager}`}`,
    ),
  );
  const catalog = cli(["catalog", "list"]);
  assert.ok(catalog.length > 0);
  assert.ok(
    catalog.every(
      (entry) =>
        entry.blockId === undefined || entry.blockId === "forge/memory",
    ),
  );
  const preview = cli([
    "config",
    "preview",
    "--input",
    JSON.stringify({
      patch: [{ op: "set", path: "/values/firstRun", value: true }],
    }),
  ]);
  assert.equal(preview.valid, true);
  assert.ok(preview.changes.length > 0);
  // The test seam must fail at the same assertion that checks the real commands.
  if (process.argv.includes("--write-fixture"))
    write("unexpected.txt", "injected write\n");
  if (process.argv.includes("--write-home"))
    mkdirSync(join(env.HOME, "unexpected-home"));
  assert.deepEqual(
    snapshot(root),
    before,
    "first-run commands changed fixture files",
  );
  assert.deepEqual(
    snapshot(sandbox),
    sandboxBefore,
    "first-run commands changed sandbox files",
  );
  assert.equal(existsSync(device), false, "no device directory is created");
  if (ecosystem !== "npm")
    assert.deepEqual(readFileSync(join(root, hook)), Buffer.from(hookBytes));
  console.log(
    `PASS default off: ${ecosystem} (${Math.round(performance.now() - started)} ms)`,
  );
}
