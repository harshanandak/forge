import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
// config.detect omits the value and file of ignored facts; read those from the packed detector.
const { detectProject, createFolderFiles } = await import(
  pathToFileURL(join(installed, "dist/src/blocks/project/index.js"))
);
function snapshot(root) {
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root, { recursive: true })
      .filter((file) => statSync(join(root, file)).isFile())
      .map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex"),
      ]),
  );
}

for (const ecosystem of ["pnpm", "python", "npm"]) {
  const started = performance.now();
  const root = join(process.cwd(), ecosystem);
  const device = join(process.cwd(), `${ecosystem}-device`);
  mkdirSync(root);
  const env = { ...process.env, FORGE_DEVICE_ROOT: device };
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
  if (ecosystem !== "npm") write(hook, hookBytes);
  const before = snapshot(root);
  const deviceBefore = snapshot(device);
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
  assert.deepEqual(
    snapshot(root),
    before,
    "first-run commands changed fixture files",
  );
  assert.deepEqual(
    snapshot(device),
    deviceBefore,
    "first-run commands changed device files",
  );
  assert.equal(existsSync(device), false, "no device directory is created");
  if (ecosystem !== "npm")
    assert.deepEqual(readFileSync(join(root, hook)), Buffer.from(hookBytes));
  console.log(
    `PASS default off: ${ecosystem} (${Math.round(performance.now() - started)} ms)`,
  );
}
