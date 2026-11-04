import { expect, test } from "bun:test";
import { nodeSensitive } from "../../tools/ci/node-sensitive.ts";
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
import { dirname, join, posix, resolve } from "node:path";
import { parse } from "yaml";
import { changedPaths, scopeOf } from "../../tools/ci/change-scope.ts";

test("docs-only source READMEs have no non-fixture source readers", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    timeout: 10_000,
  }).split("\0");
  const documents = new Set(
    files.filter((path) => /^(?:src\/.*|migrations)\/README\.md$/.test(path)),
  );
  const readers: string[] = [];
  for (const file of files.filter(
    (path) => /\.(?:ts|mjs)$/.test(path) && !path.includes("/fixtures/"),
  )) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/["'`]([^"'`\r\n]*README\.md)["'`]/g)) {
      const reference = match[1]!;
      const target = reference.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(file), reference))
        : reference;
      if (documents.has(target)) readers.push(`${file}: ${reference}`);
    }
  }
  expect(readers).toEqual([]);
}, 10_000);

test("H2: a code-to-doc rename requires full CI through the real selector", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-change-scope-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  try {
    git("init");
    mkdirSync(join(work, "src"));
    mkdirSync(join(work, "docs"));
    writeFileSync(join(work, "src/a.ts"), "export const value = 1;\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "base",
    );
    const base = git("rev-parse", "HEAD");
    git("mv", "src/a.ts", "docs/a.md");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "rename",
    );
    const head = git("rev-parse", "HEAD");
    const result = spawnSync(
      process.execPath,
      [resolve("tools/ci/change-scope.ts")],
      {
        cwd: work,
        env: {
          ...process.env,
          EVENT: "pull_request",
          BASE_SHA: base,
          HEAD_SHA: head,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("scope=full");
    expect(changedPaths(base, head, work).sort()).toEqual([
      "docs/a.md",
      "src/a.ts",
    ]);
    expect(scopeOf(changedPaths(base, base, work))).toBe("full");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

function coverShards(count: number) {
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
    mkdirSync(join(work, "tools/ci"), { recursive: true });
    writeFileSync(
      join(work, "tools/ci/test-shards.ts"),
      readFileSync(join(root, "tools/ci/test-shards.ts")),
    );
    for (const name of ["source-selection.ts", "node-sensitive.ts"])
      writeFileSync(
        join(work, "tools/ci", name),
        readFileSync(join(root, "tools/ci", name)),
      );
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
    for (const suite of ["test:unit", "test:integration"]) {
      const result = spawnSync(
        process.execPath,
        ["tools/ci/test-shards.ts", suite, "1/1", "--node26", "--list"],
        { cwd: work, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const listed = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("["))
        .flatMap((line) => JSON.parse(line) as string[]);
      const groups = suite === "test:unit" ? [expected[0]!] : expected.slice(1);
      expect(listed.sort()).toEqual(
        groups
          .flat()
          .filter((file) => file in nodeSensitive)
          .sort(),
      );
    }
    const selected: string[][] = [[], [], []];
    for (const shard of [
      "",
      ...Array.from({ length: count }, (_, i) => `${i + 1}/${count}`),
    ]) {
      const run = (script: string) => {
        const args = shard
          ? ["tools/ci/test-shards.ts", script, shard]
          : ["run", script];
        const result = spawnSync(process.execPath, args, {
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
}
test.each([2, 3])(
  "%i shards cover every suite file exactly once",
  coverShards,
  120_000,
);

test("CI Gate rejects an injected failed matrix shard", () => {
  const { jobs } = parse(
    readFileSync(resolve(".github/workflows/ci.yml"), "utf8"),
  ) as { jobs: Record<string, { needs: string[]; steps: { run: string }[] }> };
  const gate = jobs["ci-gate"]!;
  expect(gate.needs).toContain("verify");
  for (const verify of ["success", "failure", "cancelled", "skipped"]) {
    const result = spawnSync("bash", ["-c", gate.steps[0]!.run], {
      env: {
        ...process.env,
        EVENT: "pull_request",
        CODE: "true",
        STARTED: "",
        ...Object.fromEntries(
          "CHANGES STRUCTURE STATIC PR_TITLE PACK"
            .split(" ")
            .map((name) => [name, "success"]),
        ),
        VERIFY: verify,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(verify === "success" ? 0 : 1);
  }
}, 30_000);
