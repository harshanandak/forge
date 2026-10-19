import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** Real optional ecosystems: absent tools are a named skip, never a simulated pass. */
export async function ecosystems({
  directory,
  services,
  createCheck,
  detectProject,
  createFolderFiles,
}) {
  const passed = [],
    skipped = [];
  const toolsRoot =
    process.env.CHECK_ECOSYSTEM_TOOLS ??
    fileURLToPath(new URL("local-tools/", import.meta.url));
  const pythonPackages = fileURLToPath(
    new URL("local-tools/node_modules/.python-packages", import.meta.url),
  );
  const pythonPath = process.env.CHECK_PYTHON_PACKAGES ?? pythonPackages;
  if (existsSync(pythonPath))
    services = {
      ...services,
      environment: { ...services.environment, PYTHONPATH: pythonPath },
    };
  const local = createRequire(join(toolsRoot, "package.json"));
  const modules = (name) => {
    try {
      return dirname(local.resolve(`${name}/package.json`));
    } catch {
      return undefined;
    }
  };
  const run = async (name, files, explicit, required) => {
    const root = join(directory, name);
    mkdirSync(root);
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(root, path), text);
    for (const executable of required) {
      const resolved = services.process.resolve(
        executable,
        services.environment,
      );
      if (resolved.kind === "unavailable") {
        skipped.push(`${name}: ${resolved.reason}`);
        return;
      }
    }
    const observations = detectProject(createFolderFiles(root)).observations;
    const command =
      explicit ??
      observations.find((o) => o.key === "/blocks/check/config/commands/test")
        ?.value;
    assert.ok(command, `${name} project declares its command`);
    const check = createCheck({ ...services, root });
    const receipt = await check.run(
      {},
      {
        commands: { test: command },
        timeoutMs: 10000,
        maxOutputBytes: 32768,
        report: "auto",
        stopOnFailure: true,
        inputs: [],
        maxInputBytes: 1048576,
        environment: [],
      },
    );
    assert.equal(
      receipt.status,
      "PASS",
      `${name}: ${JSON.stringify(receipt.runs)}`,
    );
    if (name !== "make")
      assert.equal(receipt.runs[0].testCount, 1, `${name} real test count`);
    else
      assert.match(
        receipt.runs[0].stdout,
        /declared-project-check/,
        "real Makefile recipe executed",
      );
    assert.equal(
      (
        await check.run(
          { checks: ["lint"] },
          {
            commands: { test: command },
            timeoutMs: 1000,
            maxOutputBytes: 8192,
            report: "auto",
            stopOnFailure: true,
            inputs: [],
            maxInputBytes: 1048576,
            environment: [],
          },
        )
      ).status,
      "NOT_EXECUTED",
      `${name} has no lint`,
    );
    passed.push(name);
  };
  const vitest = modules("vitest");
  if (!vitest)
    skipped.push(
      "npm+vitest: vitest is not installed in the optional fixture tools",
    );
  else
    await run(
      "npm+vitest",
      {
        "package.json": JSON.stringify({
          name: "declared-project",
          type: "module",
          packageManager: "npm@11.0.0",
          scripts: {
            test: `node ${JSON.stringify(join(vitest, "vitest.mjs"))} run --maxWorkers=1`,
          },
          devDependencies: {
            vitest: JSON.parse(
              readFileSync(join(vitest, "package.json"), "utf8"),
            ).version,
          },
        }),
        "example.test.js": `import { test, expect } from ${JSON.stringify(pathToFileURL(join(vitest, "dist/index.js")).href)}; test('declared test', () => expect(1 + 1).toBe(2));`,
      },
      undefined,
      ["npm"],
    );
  const jest = modules("jest");
  if (!jest)
    skipped.push(
      "pnpm+jest: jest is not installed in the optional fixture tools",
    );
  else
    await run(
      "pnpm+jest",
      {
        "package.json": JSON.stringify({
          name: "declared-project",
          scripts: {
            test: `node ${JSON.stringify(join(jest, "bin/jest.js"))} --runInBand`,
          },
          devDependencies: {
            jest: JSON.parse(readFileSync(join(jest, "package.json"), "utf8"))
              .version,
          },
        }),
        "example.test.cjs":
          "test('declared test', () => expect(1 + 1).toBe(2));",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      },
      undefined,
      ["pnpm"],
    );
  const python = services.process.resolve("python", services.environment);
  if (python.kind === "unavailable")
    skipped.push("python+pytest: python is not installed");
  else {
    const probe = await services.process.run(python, ["-c", "import pytest"], {
      cwd: directory,
      env: services.environment,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    if (probe.exitCode !== 0)
      skipped.push(
        "python+pytest: pytest is not installed for the selected interpreter",
      );
    else {
      const declaration = "python -m pytest -q";
      await run(
        "python+pytest",
        {
          "pytest.ini": "[pytest]\n",
          "test_example.py": "def test_declared():\n    assert 1 + 1 == 2\n",
          "check-command.txt": declaration,
        },
        declaration,
        ["python"],
      );
    }
  }
  await run(
    "make",
    {
      Makefile: `test:\n\t@"${process.execPath.replaceAll("\\", "/")}" -e "console.log('declared-project-check')"\n`,
    },
    undefined,
    ["make"],
  );
  return { passed, skipped };
}
