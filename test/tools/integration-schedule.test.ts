import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

test.each(["test:integration", "test:changed"])(
  "%s runs spawn-heavy integration files once, after the parallel group",
  (script) => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const groups = pkg.scripts[script]!.split(" && ");
    expect(groups[0]).toBe("bun run build");
    expect(groups).toHaveLength(3);
    expect(groups[1]).toContain("--parallel --timeout 30000");
    expect(groups[1]).toContain("--path-ignore-patterns '");
    const ignore = new Bun.Glob(groups[1]!.split("'")[1]!);
    const serial = groups[2]!.replaceAll(
      / \$FORGE_TEST_(?:SHARD|TIMINGS|UPDATE)_ARG/g,
      "",
    );
    expect(serial).toStartWith("bun test --timeout 30000 ");
    expect(serial).not.toContain("--parallel");
    if (script === "test:changed") {
      expect(groups[1]).toContain("--changed=origin/main");
      expect(serial).toContain("--changed=origin/main");
    }
    const files = [
      ...(script === "test:integration"
        ? [
            ["adapters/l5-state", "private-repair"],
            ["assembly", "state-acl-cli"],
          ]
        : []),
      ["adapters/l5-state", "private-files"],
      ["surface", "help-examples"],
      ["adapters/vcs-git", "vcs-git"],
      ["assembly/shared-store", "shared-store"],
      ["tools", "lane-run"],
      ["tools", "lane"],
      ["tools", "lane-close"],
    ];
    for (const [folder, name] of files) {
      const path = `test/${folder}/${name}.integration.test.ts`;
      expect(serial.split(" ").filter((arg) => arg === path)).toHaveLength(1);
      expect(ignore.match(path), `${path} excluded from bulk`).toBe(true);
    }
    const serialPaths = serial
      .split(" ")
      .filter((arg) => arg.endsWith(".test.ts"));
    expect(serialPaths).toHaveLength(files.length);
    const integrationPaths = [
      ...new Bun.Glob("test/**/*.integration.test.ts").scanSync("."),
    ]
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => !path.endsWith("/packed.integration.test.ts"));
    const parallelPaths = integrationPaths.filter(
      (path) => !ignore.match(path),
    );
    expect([...parallelPaths, ...serialPaths].sort()).toEqual(
      integrationPaths.sort(),
    );
    expect(
      ignore.match("test/integration/custom-block/packed.integration.test.ts"),
    ).toBe(true);
    expect(ignore.match("test/assembly/sqlite-acl.integration.test.ts")).toBe(
      false,
    );
  },
  30_000,
);

test.each([
  { code: 0, banner: true, expected: 0 },
  { code: 17, banner: true, expected: 17 },
  { code: 18, banner: true, expected: 18 },
  { code: 19, banner: false, expected: 19 },
  { code: 0, banner: false, expected: 1 },
  { code: null, banner: true, expected: 1 },
])(
  "Windows probe waits for parallel start and preserves exit $code",
  ({ code, banner, expected }) => {
    const workflow = parse(
      readFileSync(".github/workflows/ci.yml", "utf8"),
    ) as {
      jobs: {
        verify: { steps: { name?: string; if?: string; run?: string }[] };
      };
    };
    const steps = workflow.jobs.verify.steps;
    const probe = steps.find(
      (step) => step.name === "Windows integration timing probe",
    )!;
    const integration = steps.find(
      (step) => step.name === "Integration tests",
    )!;
    expect(steps.indexOf(probe)).toBeLessThan(steps.indexOf(integration));
    expect(probe.if).toBe("matrix.suite != 'pack' && runner.os == 'Windows'");
    expect(integration.if).toBe(
      "matrix.suite != 'pack' && runner.os != 'Windows'",
    );
    expect(integration.run).toBe("bun run test:integration");
    const source = probe.run!.split("<<'NODE'\n")[1]!.replace(/NODE\s*$/, "");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const probes: string[] = [];
    const state = {
      stdout: { write() {} },
      stderr: { write() {} },
      exitCode: undefined as number | undefined,
    };
    runInNewContext(source, {
      process: state,
      console: { log() {}, error() {} },
      require: (name: string) =>
        name === "node:perf_hooks"
          ? { performance }
          : {
              spawnSync: (
                command: string,
                args: string[],
                options: { timeout: number },
              ) => {
                expect(command).toBe("powershell.exe");
                expect(args).toEqual([
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  "exit",
                ]);
                expect(options.timeout).toBe(15000);
                probes.push("probe");
                return { status: 0, signal: null };
              },
              spawn: (command: string, args: string[]) => {
                expect(command).toBe("bun");
                expect(args).toEqual(["run", "test:integration"]);
                probes.push("suite");
                return child;
              },
            },
    });
    expect(probes).toEqual(["probe", "suite"]);
    child.stderr.emit("data", "$ bun run build && bun test --parallel\n");
    expect(probes).toHaveLength(2);
    if (banner) {
      child.stdout.emit("data", "bun test v1.4.4 ");
      expect(probes).toHaveLength(2);
      child.stdout.emit("data", "8x PARALLEL\r\n");
      child.stderr.emit("data", "bun test v1.4.4 8x PARALLEL\n");
      expect(probes).toEqual(["probe", "suite", "probe"]);
    }
    expect(state.exitCode).toBeUndefined();
    child.emit("close", code);
    expect(state.exitCode).toBe(expected);
  },
  30_000,
);
