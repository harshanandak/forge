// [integration] Real tool CLI; fake gh serves shard artifacts without network.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parse } from "yaml";

const script = resolve(import.meta.dir, "../../tools/timings-merge.ts");
function fixture(missing = "", invalid = false) {
  const root = mkdtempSync(join(tmpdir(), "forge-timings-merge-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "package.json"), '{"private":true}');
  writeFileSync(
    join(root, "test/timings.json"),
    '{"version":1,"files":{"old":1}}',
  );
  const fake = join(root, "gh.mjs");
  writeFileSync(
    fake,
    `import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const a=process.argv.slice(2);
if(a[0]==='auth'&&a[1]==='token'&&a.includes('fixture-user')) console.log('fixture-credential');
else if(a[0]==='run'&&a[1]==='download'&&a[2]==='123'&&a.includes('--pattern')&&a[a.indexOf('--pattern')+1]==='windows-timings-*'&&process.env.GH_TOKEN==='fixture-credential') {
 const dir=a[a.indexOf('--dir')+1];
 for(const node of [24,26]) for(const shard of [1,2,3]) {
  const name='windows-timings-node-'+node+'-shard-'+shard;
  if(name===${JSON.stringify(missing)}) continue;
  mkdirSync(join(dir,name),{recursive:true});
  for(const suite of ['unit','parallel','serial']) {
   const path='test/'+suite+'-'+shard+'.test.ts';
   const files={[path]:${invalid ? "'bad'" : "node===24?shard*10:shard*20"},'test/shared.test.ts':node===24?99:1};
   writeFileSync(join(dir,name,'timings-'+suite+'.json'),JSON.stringify({version:1,files}));
  }
 }
} else {console.error('unexpected gh call');process.exit(1);}`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${fake.replaceAll("\\", "/")}" "$@"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  if (process.platform === "win32")
    writeFileSync(
      join(bin, "gh.cmd"),
      `@"${process.execPath}" "${fake}" %*\r\n`,
    );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_GH_USER: "fixture-user",
    FORGE_DEVICE_ROOT: join(root, "device"),
  };
  const key =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[key] = bin + delimiter + (env[key] ?? "");
  return {
    root,
    run: () =>
      spawnSync(process.execPath, [script, "123"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15_000,
      }),
  };
}

test("downloads every shard and merges all files using the slower Node measurement", () => {
  const { root, run } = fixture();
  try {
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, files: 10 });
    const expected: Record<string, number> = { "test/shared.test.ts": 99 };
    for (const suite of ["unit", "parallel", "serial"])
      for (const shard of [1, 2, 3])
        expected[`test/${suite}-${shard}.test.ts`] = shard * 20;
    expect(
      JSON.parse(readFileSync(join(root, "test/timings.json"), "utf8")),
    ).toEqual({ version: 1, files: expected });
    expect(result.stdout + result.stderr).not.toContain("fixture-credential");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("CI collection preserves the baseline and every phase's shard coverage", () => {
  const repo = resolve(import.meta.dir, "../..");
  const root = mkdtempSync(join(tmpdir(), "forge-timings-collection-"));
  const workflow = parse(
    readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
  ) as {
    jobs: {
      verify: {
        env: Record<string, string>;
        steps: { name?: string; run?: string }[];
      };
    };
  };
  const job = workflow.jobs.verify;
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  pkg.scripts.build = "bun -e 'console.log(\"BUILD\")'";
  pkg.scripts.prebuild = "";
  pkg.scripts.postbuild = "";
  const files = [
    "test/a.test.ts",
    "test/b.test.ts",
    "test/c.test.ts",
    "test/a.integration.test.ts",
    "test/b.integration.test.ts",
    "test/c.integration.test.ts",
    "test/adapters/l5-state/private-files.integration.test.ts",
    "test/surface/help-examples.integration.test.ts",
    "test/adapters/vcs-git/vcs-git.integration.test.ts",
    "test/assembly/shared-store/shared-store.integration.test.ts",
    "test/tools/lane-run.integration.test.ts",
    "test/tools/lane.integration.test.ts",
    "test/tools/lane-close.integration.test.ts",
  ];
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    for (const path of files) {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      writeFileSync(
        join(root, path),
        "import {test} from 'bun:test'; test('file',()=>{},1000);",
      );
    }
    const baseline = JSON.stringify({
      version: 1,
      files: Object.fromEntries(files.map((path, i) => [path, (i + 1) * 10])),
    });
    writeFileSync(join(root, "test/timings.json"), baseline);
    const selected: string[] = [];
    for (const shard of [1, 2, 3]) {
      const env = {
        ...process.env,
        FORGE_DEVICE_ROOT: join(root, "device"),
        FORGE_TEST_SHARD_ARG: `--shard=${shard}/3`,
        FORGE_TEST_TIMINGS_ARG: job.env.FORGE_TEST_TIMINGS_ARG!.split("'")[1]!,
        FORGE_TEST_UPDATE_ARG: "--update-timings",
      };
      for (const name of ["Unit tests", "Integration tests"]) {
        const command = job.steps
          .find((step) => step.name === name)!
          .run!.replaceAll(/\$\{\{.*?\}\}/g, "--timings=test/timings.json");
        const result = spawnSync(
          "bash",
          ["-e", "-o", "pipefail", "-c", command],
          { cwd: root, env, encoding: "utf8", timeout: 15_000 },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
      }
      for (const suite of ["unit", "parallel", "serial"]) {
        const path = join(root, `timings-${suite}.json`);
        expect(
          Bun.file(path).size,
          `Missing ${suite} timing file`,
        ).toBeGreaterThan(0);
        const data = JSON.parse(readFileSync(path, "utf8")) as {
          files: Record<string, number>;
        };
        selected.push(...Object.keys(data.files));
      }
      expect(readFileSync(join(root, "test/timings.json"), "utf8")).toBe(
        baseline,
      );
    }
    expect(selected.sort()).toEqual(files.sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("missing shard and invalid timing fail clearly without replacing the baseline", () => {
  for (const invalid of [false, true]) {
    const { root, run } = fixture(
      invalid ? "" : "windows-timings-node-26-shard-3",
      invalid,
    );
    try {
      const result = run();
      expect(result.status).toBe(1);
      expect((JSON.parse(result.stdout) as { error: string }).error).toContain(
        invalid
          ? "Invalid timing"
          : "Missing timing artifact: windows-timings-node-26-shard-3",
      );
      expect(
        JSON.parse(readFileSync(join(root, "test/timings.json"), "utf8")),
      ).toEqual({ version: 1, files: { old: 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);
