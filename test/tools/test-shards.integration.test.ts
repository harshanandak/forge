import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

test("three shards cover every original suite file exactly once, including unknown timings", () => {
  const root = resolve(import.meta.dir, "../..");
  const work = mkdtempSync(join(tmpdir(), "forge-test-shards-"));
  const files = execFileSync("git", ["ls-files", "--", "*.test.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  const serial = [
    "private-files",
    "private-repair",
    "state-acl-cli",
    "help-examples",
    "vcs-git",
    "shared-store",
    "lane-run",
    "lane",
    "lane-close",
  ];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const expected = [
    files.filter((path) => !path.endsWith(".integration.test.ts")),
    files.filter(
      (path) =>
        path.endsWith(".integration.test.ts") &&
        !["packed", ...serial].some((name) =>
          path.endsWith(`/${name}.integration.test.ts`),
        ),
    ),
    files.filter((path) =>
      serial.some((name) => path.endsWith(`/${name}.integration.test.ts`)),
    ),
  ];
  try {
    writeFileSync(
      join(work, "package.json"),
      JSON.stringify({
        ...pkg,
        scripts: {
          ...pkg.scripts,
          build: "bun -e 'console.log(\"BUILD_ONCE\")'",
          prebuild: "",
          postbuild: "",
        },
      }),
    );
    for (const path of files) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(
        join(work, path),
        `import {test} from "bun:test"; test("file", () => console.log(${JSON.stringify(`SELECTED:${path}`)}), 1000);`,
      );
    }
    const timings = (
      existsSync(join(root, "test/timings.json"))
        ? JSON.parse(readFileSync(join(root, "test/timings.json"), "utf8"))
        : { files: {} }
    ) as { files: Record<string, number> };
    // New test paths have no measurements yet and must still be selected.
    for (const group of expected) delete timings.files[group[0]!];
    writeFileSync(join(work, "test/timings.json"), JSON.stringify(timings));
    const selected: string[][] = [[], [], []];
    for (const shard of ["", "1/3", "2/3", "3/3"]) {
      const run = (script: string) => {
        const result = spawnSync(process.execPath, ["run", script], {
          cwd: work,
          env: {
            ...process.env,
            FORGE_TEST_SHARD_ARG: shard ? `--shard=${shard}` : "",
            FORGE_TEST_TIMINGS_ARG: shard ? "--timings=test/timings.json" : "",
            FORGE_TEST_UPDATE_ARG: "",
          },
          encoding: "utf8",
          timeout: 60_000,
        });
        expect(
          result.status,
          `${script} ${shard}: ${result.stdout}\n${result.stderr}`,
        ).toBe(0);
        return `${result.stdout}\n${result.stderr}`;
      };
      const unit = run("test:unit");
      const integration = run("test:integration");
      expect(integration.match(/^BUILD_ONCE\r?$/gm)).toHaveLength(1);
      const paths = (text: string) =>
        [...text.matchAll(/^SELECTED:(.+)$/gm)].map((match) =>
          match[1]!.trim(),
        );
      const groups = [
        paths(unit),
        paths(integration).filter((path) => expected[1]!.includes(path)),
        paths(integration).filter((path) => expected[2]!.includes(path)),
      ];
      expect(
        paths(integration).every(
          (path) => expected[1]!.includes(path) || expected[2]!.includes(path),
        ),
      ).toBe(true);
      if (!shard)
        expect(paths(integration).sort()).toEqual(
          [...expected[1]!, ...expected[2]!].sort(),
        );
      for (let index = 0; index < groups.length; index++) {
        if (!shard)
          expect(groups[index]!.sort()).toEqual(expected[index]!.toSorted());
        else selected[index]!.push(...groups[index]!);
      }
    }
    for (let index = 0; index < selected.length; index++) {
      expect(selected[index]!.toSorted()).toEqual(expected[index]!.toSorted());
      expect(new Set(selected[index]).size).toBe(expected[index]!.length);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
