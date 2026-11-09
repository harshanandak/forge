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

const quotes = "\"'`";
const readmeReference = new RegExp(
  `[${quotes}]([^${quotes}\\r\\n]*README\\.md)[${quotes}]`,
  "g",
);
const possibleReader = new RegExp(
  `\\breadFile(?:Sync)?\\s*\\(|\\bBun\\.file\\s*\\(|(?:from|import)\\s*[${quotes}][^${quotes}]*README\\.md`,
);

test("the docs-only migration README has no non-fixture source readers", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    timeout: 10_000,
  }).split("\0");
  const documents = new Set<string>(
    files.filter((path) => path === posix.join("migrations", "README.md")),
  );
  const readers: string[] = [];
  for (const file of files.filter(
    (path) => /\.(?:ts|mjs)$/.test(path) && !path.includes("/fixtures/"),
  )) {
    const text = readFileSync(file, "utf8");
    if (!possibleReader.test(text)) continue;
    for (const match of text.matchAll(readmeReference)) {
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
    for (const event of ["push", "workflow_dispatch", ""]) {
      const main = spawnSync(
        process.execPath,
        [resolve("tools/ci/change-scope.ts")],
        {
          cwd: work,
          env: { ...process.env, EVENT: event, BASE_SHA: "", HEAD_SHA: "" },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(main.status, main.stderr).toBe(0);
      expect(main.stdout.trim()).toBe("scope=full");
    }
    const invalid = spawnSync(
      process.execPath,
      [resolve("tools/ci/change-scope.ts")],
      {
        cwd: work,
        env: {
          ...process.env,
          EVENT: "pull_request",
          BASE_SHA: "not-a-revision",
          HEAD_SHA: head,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe("");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

test("diverged histories retain a source patch shared by the base tip and PR head", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-change-scope-diverged-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  const commit = (message: string) => {
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init");
    mkdirSync(join(work, "src"));
    mkdirSync(join(work, "docs"));
    writeFileSync(join(work, "src/a.ts"), "export const value = 1;\n");
    writeFileSync(join(work, "docs/guide.md"), "Original guide\n");
    const ancestor = commit("ancestor");
    git("checkout", "-b", "base");
    writeFileSync(join(work, "src/a.ts"), "export const value = 2;\n");
    const base = commit("base source patch");
    git("checkout", "-b", "feature", ancestor);
    writeFileSync(join(work, "src/a.ts"), "export const value = 2;\n");
    writeFileSync(join(work, "docs/guide.md"), "Updated guide\n");
    const head = commit("independent source patch and docs");
    expect(git("diff", "--no-renames", "--name-only", base, head)).toBe(
      "docs/guide.md",
    );
    const paths = changedPaths(base, head, work);
    expect(paths.sort()).toEqual(["docs/guide.md", "src/a.ts"]);
    expect(scopeOf(paths)).toBe("full");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

test("CI groups main pushes by run and supersedes only runs for the same PR", () => {
  const { concurrency } = parse(
    readFileSync(resolve(".github/workflows/ci.yml"), "utf8"),
  ) as {
    concurrency: { group: string; "cancel-in-progress": string };
  };
  expect(concurrency.group).toBe(
    "ci-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}",
  );
  expect(concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
}, 1000);

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

test.each(
  [
    {
      scope: "full",
      event: "pull_request",
      pack: "success",
      verify: "success",
      expected: 0,
    },
    {
      scope: "full",
      event: "push",
      pack: "success",
      verify: "success",
      expected: 0,
    },
    ...["failure", "cancelled", "skipped"].flatMap((result) => [
      {
        scope: "full",
        event: "pull_request",
        pack: "success",
        verify: result,
        expected: 1,
      },
      {
        scope: "full",
        event: "pull_request",
        pack: result,
        verify: "success",
        expected: 1,
      },
    ]),
    {
      scope: "docs",
      event: "pull_request",
      pack: "skipped",
      verify: "skipped",
      expected: 0,
    },
    ...["success", "failure", "cancelled"].flatMap((result) => [
      {
        scope: "docs",
        event: "pull_request",
        pack: "skipped",
        verify: result,
        expected: 1,
      },
      {
        scope: "docs",
        event: "pull_request",
        pack: result,
        verify: "skipped",
        expected: 1,
      },
    ]),
    {
      scope: "docs",
      event: "push",
      pack: "skipped",
      verify: "skipped",
      expected: 1,
    },
    ...["", "unknown", "linux"].map((scope) => ({
      scope,
      event: "pull_request",
      pack: "skipped",
      verify: "skipped",
      expected: 1,
    })),
    ...["failure", "cancelled", "skipped", ""].flatMap((changes) => [
      {
        changes,
        scope: "full",
        event: "pull_request",
        pack: "success",
        verify: "success",
        expected: 1,
      },
      {
        changes,
        scope: "docs",
        event: "pull_request",
        pack: "skipped",
        verify: "skipped",
        expected: 1,
      },
    ]),
    ...["failure", "cancelled", "skipped"].map((speed) => ({
      scope: "full",
      event: "pull_request",
      pack: "success",
      verify: "success",
      speed,
      expected: 1,
    })),
    ...["success", "failure", "cancelled"].map((speed) => ({
      scope: "docs",
      event: "pull_request",
      pack: "skipped",
      verify: "skipped",
      speed,
      expected: 1,
    })),
  ].map((entry) => ({
    changes: "success",
    speed: entry.scope === "full" ? "success" : "skipped",
    ...entry,
  })),
)(
  "CI Gate enforces scope and required results: %j",
  ({ scope, event, pack, verify, expected, changes, speed }) => {
    const { jobs } = parse(
      readFileSync(resolve(".github/workflows/ci.yml"), "utf8"),
    ) as {
      jobs: Record<string, { needs: string[]; steps: { run: string }[] }>;
    };
    const gate = jobs["ci-gate"]!;
    expect(gate.needs).toContain("verify");
    expect(gate.needs).toContain("speed");
    const result = spawnSync("bash", ["-c", gate.steps[0]!.run], {
      env: {
        ...process.env,
        EVENT: event,
        SCOPE: scope,
        STARTED: "",
        ...Object.fromEntries(
          "CHANGES STRUCTURE STATIC PR_TITLE"
            .split(" ")
            .map((name) => [name, "success"]),
        ),
        VERIFY: verify,
        PACK: pack,
        SPEED: speed,
        CHANGES: changes,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(expected);
  },
  30_000,
);
