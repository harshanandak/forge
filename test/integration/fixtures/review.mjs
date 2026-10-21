import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createAssembly } from "forge-workflow/runtime";

assert.equal(process.versions.bun, undefined);
const mode = process.argv[2] ?? "all";
const bin = fileURLToPath(
  new URL(
    "dist/bin/forge.js",
    import.meta.resolve("forge-workflow/package.json"),
  ),
);
const work = mkdtempSync(join(process.cwd(), "review-"));
function project(name) {
  const root = join(work, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    '{"name":"consumer","version":"1.0.0"}',
  );
  return root;
}
function cli(root, args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(
    result.status,
    expected,
    `${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}
function block(path, noun) {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "forge.block.json"),
    JSON.stringify({
      schemaVersion: "forge.block/1",
      id: `example.org/${noun}`,
      version: "1.0.0",
      authorAbi: "forge.author/v1",
      profile: "trusted-action-sync/v1",
      entry: "index.cjs",
      docs: "docs.json",
      operations: {
        [`${noun}.echo`]: {
          input: "input.json",
          output: "output.json",
          args: ["value"],
          context: "stateless",
          timeoutMs: 15000,
          effects: [],
          idempotent: true,
          callers: ["human", "agent"],
          stability: "stable",
        },
      },
    }),
  );
  for (const name of ["input", "output"])
    writeFileSync(
      join(path, `${name}.json`),
      JSON.stringify({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      }),
    );
  writeFileSync(
    join(path, "docs.json"),
    JSON.stringify({
      operations: {
        [`${noun}.echo`]: {
          title: "Echo",
          summary: "Echo the caller's value.",
        },
      },
    }),
  );
  writeFileSync(
    join(path, "index.cjs"),
    `module.exports = { '${noun}.echo': ({input}) => input };`,
  );
}
try {
  if (mode === "all" || mode === "missing-sources") {
    const root = project("missing");
    block(join(root, "good"), "good");
    block(join(root, "removed"), "removed");
    const removedPackage = join(root, "node_modules", "removed-block");
    block(removedPackage, "uninstalled");
    writeFileSync(
      join(removedPackage, "package.json"),
      '{"name":"removed-block","version":"1.0.0"}',
    );
    mkdirSync(join(root, ".forge"));
    const bytes = JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        good: { source: { path: "./good" } },
        removed: { source: { path: "./removed" } },
        uninstalled: { source: { package: "removed-block" } },
        absent: { source: { builtin: "forge/absent" } },
      },
    });
    writeFileSync(join(root, ".forge/config.yaml"), bytes);
    rmSync(join(root, "removed"), { recursive: true, force: true });
    rmSync(removedPackage, { recursive: true, force: true });
    const show = cli(root, ["config", "show"], 6);
    assert.equal(show.ok, false, "missing sources make config invalid");
    assert.ok(
      show.result,
      "config show must retain readable invalid configuration",
    );
    assert.equal(show.result.valid, false);
    assert.equal(show.error.message, show.result.problems.join("\n"));
    for (const name of ["removed", "uninstalled"])
      assert.ok(
        show.result.problems.some(
          (problem) =>
            problem.includes(`blocks.${name}.source:`) &&
            problem.includes(
              `Repair the source or configuration for ${name}`,
            ) &&
            problem.includes(`remove /blocks/${name} with config.apply`),
        ),
        `visible source diagnostic and repair for ${name}`,
      );
    assert.match(show.error.message, /blocks\.removed\.source:/);
    assert.match(show.error.message, /blocks\.uninstalled\.source:/);
    assert.match(
      show.error.message,
      /blocks\.absent\.source\.builtin:.*got "forge\/absent".*Fix:/,
    );
    assert.equal(show.result.instances.length, 4);
    assert.equal(
      readFileSync(join(root, ".forge/config.yaml"), "utf8"),
      bytes,
      "diagnosis must not rewrite config",
    );
    assert.equal(existsSync(join(root, ".forge/state.sqlite")), false);
    assert.equal(existsSync(join(root, "device")), false);
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      assert.equal(assembly.catalog.unavailable().length, 3);
      for (const unavailable of assembly.catalog.unavailable()) {
        assert.ok(unavailable.reason);
        assert.ok(unavailable.remedy.includes(unavailable.name));
      }
      assert.ok(
        assembly.catalog.list().some((entry) => entry.op === "good.echo"),
        "healthy block remains in catalog",
      );
    } finally {
      await assembly.close();
    }
    const checked = cli(root, ["block", "check", "./good"]);
    cli(root, ["block", "admit", checked.result.digest]);
    assert.deepEqual(
      cli(root, ["good", "echo", "still works"]).result,
      { value: "still works" },
      "healthy operations survive unrelated missing sources",
    );
    cli(root, [
      "config",
      "apply",
      "--input",
      JSON.stringify({
        expectRevision: show.result.revision,
        patch: ["removed", "uninstalled", "absent"].map((name) => ({
          op: "remove",
          path: `/blocks/${name}`,
        })),
      }),
    ]);
    assert.deepEqual(
      cli(root, ["config", "show"]).result.problems,
      [],
      "config remains repairable",
    );
    console.log(
      "PASS missing-sources: deleted path, removed package and absent builtin remain visible and repairable",
    );
  }
  if (mode === "all" || mode === "package-roots") {
    for (const [name, spec, ancestor] of [
      ["hidden", "hidden-block", false],
      ["scoped", "@fixture/hidden-block", true],
    ]) {
      const root = project(name);
      const packageRoot = join(ancestor ? work : root, "node_modules", spec);
      block(packageRoot, name);
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: spec,
          version: "1.0.0",
          exports: { ".": "./public.mjs" },
        }),
      );
      writeFileSync(
        join(packageRoot, "public.mjs"),
        'throw new Error("package entry must not execute during capture");',
      );
      const require = createRequire(join(root, "package.json"));
      assert.throws(
        () => require.resolve(`${spec}/package.json`),
        { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
        "fixture really hides package.json",
      );
      assert.equal(
        cli(root, ["block", "check", spec]).ok,
        true,
        "exports-hidden package check",
      );
      const added = cli(root, ["block", "add", spec], 2);
      assert.equal(
        added.error.code,
        "ADMISSION_REQUIRED",
        "exports-hidden package add",
      );
      const digest = added.error.repair.match(/sha256:[a-f0-9]{64}/)[0];
      cli(root, ["block", "admit", digest]);
      assert.deepEqual(
        cli(root, [name, "echo", "from package"]).result,
        { value: "from package" },
        "exports-hidden package subsequent snapshot",
      );
      assert.equal(
        cli(root, ["config", "show"]).result.instances[0].source.package,
        spec,
      );
    }
    console.log(
      "PASS package-roots: unscoped and scoped ancestor packages work without an exported package.json",
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
