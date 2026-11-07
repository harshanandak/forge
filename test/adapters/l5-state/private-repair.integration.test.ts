// [integration] Execute the emitted repair in every installed PowerShell edition on temp files.
import { afterAll, expect, test, setDefaultTimeout } from "bun:test";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powerShellBatch } from "../../child-step.ts";
import { windowsPrivateFiles } from "../../../src/adapters/process/windows-acl.ts";
import { privateFileGuard } from "../../../src/adapters/store-sqlite/private-files.ts";

setDefaultTimeout(30000);
const shells = [
  "powershell.exe",
  ...(Bun.which("pwsh") ? [Bun.which("pwsh")!] : []),
];
const quotes = ["'", "\u2018", "\u2019", "\u201a", "\u201b"];
const batch = powerShellBatch();
const started = performance.now();
const roots: string[] = [];
const caseNames: string[] = [];
function windowsTest(
  name: string,
  run: () => void | Promise<void>,
  timeout = 30000,
) {
  caseNames.push(name);
  test.skipIf(process.platform !== "win32")(name, run, timeout);
}
afterAll(() => {
  try {
    if (process.platform === "win32") {
      console.log(
        `private-repair: ${Math.round(performance.now() - started)} ms (study 4559.32 ms); PowerShell launches ${batch.launches} (was ${5 * shells.length + 1})`,
      );
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
windowsTest(
  "borrowed folder refusal gives guidance without changing its tree or siblings",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-repair-directory-"));
    try {
      const native = windowsPrivateFiles();
      privateFileGuard(native).directory(root);
      const path = join(root, "borrowed\u2019; Write-Output INJECTED; \u2019");
      mkdirSync(path);
      native.protect(path, `D:P(A;OICI;FA;;;${native.sid})(A;OICI;FR;;;WD)`);
      const sibling = join(root, "sibling.txt");
      const file = join(path, "file.txt");
      const nested = join(path, "nested");
      const nestedFile = join(nested, "file.txt");
      writeFileSync(sibling, "sibling data");
      writeFileSync(file, "folder data");
      mkdirSync(nested);
      writeFileSync(nestedFile, "nested data");
      const snapshot = () => ({
        directories: [root, path, nested].map((directory) => ({
          acl: native.read(directory),
          entries: readdirSync(directory),
        })),
        files: [sibling, file, nestedFile].map((entry) => ({
          acl: native.read(entry),
          bytes: readFileSync(entry),
        })),
      });
      const before = snapshot();
      const guard = privateFileGuard(native, { protectDirectories: false });
      let message = "";
      try {
        guard.directory(path);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("Private ACL verification failed");
      expect(message).toContain(
        "Move the store into a folder only you can access.",
      );
      expect(message).not.toContain("let Forge create");
      expect(message).not.toContain("Repair in PowerShell:");
      expect(message).not.toMatch(
        /SetAccessControl|SetSecurityDescriptorSddlForm|DirectorySecurity|Set-Acl|icacls/i,
      );
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
windowsTest(
  "PowerShell timeout names the running command phase",
  async () => {
    const launches = batch.launches;
    const message = await batch
      .run(
        "powershell.exe",
        [{ name: "deadline probe", command: "Start-Sleep -Seconds 60" }],
        5000,
      )
      .then(() => "", String);
    const match = /timeout; phase=([^;]+); case=([^;]+); (\{.*\});/.exec(
      message,
    );
    expect(match).not.toBeNull();
    const phases = JSON.parse(match![3]!) as Record<string, string | undefined>;
    expect(typeof phases.spawn).toBe("string");
    expect(typeof phases.exit).toBe("string");
    expect(match![1]).toBe(
      phases.commandStart
        ? "command"
        : phases.firstOutput
          ? "startup-output"
          : "startup",
    );
    expect(match![2]).toBe(phases.case ?? "pending");
    expect([undefined, "deadline probe"]).toContain(phases.case);
    if (!phases.commandStart) expect(phases.case).toBeUndefined();
    expect(batch.launches - launches).toBe(1);
  },
  10000,
);
test("PowerShell timeout follows recorded phases and batch case order", async () => {
  const commandStart = "FORGE_COMMAND_START:2026-11-03T00:00:00.000Z\n";
  for (const [output, phase, name, stderr] of [
    ["", "startup", "pending"],
    ["loading\n", "startup-output", "pending"],
    ["", "startup-output", "pending", "loading\n"],
    [commandStart, "command", "pending"],
    [`${commandStart}FORGE_CASE_START:0\n`, "command", "completed probe"],
    [
      `${commandStart}FORGE_CASE_START:0\nready\nFORGE_CASE_END:0:0\nFORGE_CASE_START:1\n`,
      "command",
      "deadline probe",
    ],
  ] as const) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => child.emit("close", null),
    });
    const simulated = powerShellBatch(() => {
      queueMicrotask(() => {
        if (output) child.stdout.emit("data", Buffer.from(output));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      });
      return child;
    });
    await expect(
      simulated.run(
        "powershell.exe",
        [
          { name: "completed probe", command: "Write-Output ready" },
          { name: "deadline probe", command: "Start-Sleep -Seconds 60" },
        ],
        0,
      ),
    ).rejects.toThrow(`timeout; phase=${phase}; case=${name};`);
    expect(simulated.launches).toBe(1);
  }
});
const COMMAND_START = "FORGE_COMMAND_START:2026-11-03T00:00:00.000Z\n";
const BUDGET = 100;
/**
 * A fake PowerShell for runEach. Each launch prints its scripted output. A launch with an `exit`
 * code closes at once; one without stalls until the deadline kills it, and the kill advances the
 * fake clock by `stallCost`, so budget accounting is exact and no test depends on real timing.
 */
function simulatedEach(
  launches: { output: string; exit?: number }[],
  stallCost: number,
) {
  let clock = 0;
  const scripts: string[] = [];
  const delays: number[] = [];
  const batch = powerShellBatch(
    (_shell, args) => {
      const launch = scripts.push(args.at(-1)!) - 1;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          clock += stallCost;
          child.emit("close", null);
        },
      });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(launches[launch]!.output));
        const exit = launches[launch]!.exit;
        if (exit !== undefined) child.emit("close", exit);
      });
      return child;
    },
    () => clock,
  );
  const run = async (names: string[]) => {
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if (ms !== undefined) delays.push(ms);
      return real(handler, ms);
    }) as unknown as typeof setTimeout;
    try {
      return await batch.runEach(
        "powershell.exe",
        names.map((name) => ({ name, command: `Write-Output ${name}` })),
        BUDGET,
      );
    } finally {
      globalThis.setTimeout = real;
    }
  };
  return { batch, scripts, delays, run };
}
test("a stalled batch case fails alone and the cases after it still run on the budget that is left", async () => {
  const { batch, scripts, delays, run } = simulatedEach(
    [
      {
        output: `${COMMAND_START}FORGE_CASE_START:0
first
FORGE_CASE_END:0:0
FORGE_CASE_START:1
`,
      },
      {
        output: `${COMMAND_START}FORGE_CASE_START:0
third
FORGE_CASE_END:0:0
FORGE_CASE_START:1
fourth
FORGE_CASE_END:1:1
`,
        exit: 0,
      },
    ],
    40,
  );
  const outcomes = await run(["first", "stalled", "third", "fourth"]);
  expect(outcomes.map(({ name }) => name)).toEqual([
    "first",
    "stalled",
    "third",
    "fourth",
  ]);
  expect(outcomes[0]).toMatchObject({ status: 0, stdout: "first\n" });
  expect(outcomes[1]).toMatchObject({ status: -1, reason: "timeout" });
  expect(outcomes[1]!.stderr).toContain(
    "timeout; phase=command; case=stalled;",
  );
  expect(outcomes[2]).toMatchObject({ status: 0, stdout: "third\n" });
  expect(outcomes[3]).toMatchObject({ status: 1, stdout: "fourth\n" });
  expect(batch.launches).toBe(2);
  expect(scripts[1]).toContain("Write-Output third");
  expect(scripts[1]).toContain("Write-Output fourth");
  expect(scripts[1]).not.toContain("Write-Output first");
  expect(scripts[1]).not.toContain("Write-Output stalled");
  // The fresh launch gets what the first one left, never a new full budget.
  expect(delays.filter((ms) => ms === BUDGET || ms === BUDGET - 40)).toEqual([
    BUDGET,
    BUDGET - 40,
  ]);
}, 5000);
test("a stall on the last case starts no extra launch", async () => {
  const { batch, run } = simulatedEach(
    [
      {
        output: `${COMMAND_START}FORGE_CASE_START:0
first
FORGE_CASE_END:0:0
FORGE_CASE_START:1
`,
      },
    ],
    40,
  );
  const outcomes = await run(["first", "stalled"]);
  expect(outcomes[0]).toMatchObject({ status: 0, stdout: "first\n" });
  expect(outcomes[1]).toMatchObject({ status: -1, reason: "timeout" });
  expect(batch.launches).toBe(1);
}, 5000);
test("a stall that spends the whole budget leaves the later cases not run and launches nothing", async () => {
  const { batch, run } = simulatedEach(
    [
      {
        output: `${COMMAND_START}FORGE_CASE_START:0
first
FORGE_CASE_END:0:0
FORGE_CASE_START:1
`,
      },
    ],
    BUDGET,
  );
  const outcomes = await run(["first", "stalled", "third", "fourth"]);
  expect(outcomes.map(({ reason }) => reason)).toEqual([
    undefined,
    "timeout",
    "not-run",
    "not-run",
  ]);
  expect(outcomes.map(({ status }) => status)).toEqual([0, -1, -1, -1]);
  for (const outcome of outcomes.slice(2))
    expect(outcome.stderr).toBe(
      "deadline exhausted; not run (after stalled stalled)",
    );
  expect(batch.launches).toBe(1);
}, 5000);
test("a launch that exits non-zero after every case finished still fails the last case", async () => {
  const { batch, run } = simulatedEach(
    [
      {
        output: `${COMMAND_START}FORGE_CASE_START:0
first
FORGE_CASE_END:0:0
FORGE_CASE_START:1
second
FORGE_CASE_END:1:0
`,
        exit: 3,
      },
    ],
    40,
  );
  const outcomes = await run(["first", "second"]);
  expect(outcomes[0]).toMatchObject({ status: 0, stdout: "first\n" });
  expect(outcomes[1]).toMatchObject({
    status: -1,
    stdout: "second\n",
    reason: "exit",
  });
  expect(outcomes[1]!.stderr).toContain("PowerShell exit 3;");
  expect(batch.launches).toBe(1);
}, 5000);
for (const shell of shells) {
  async function prepare() {
    const cases = quotes.map((quote) => {
      const root = mkdtempSync(join(tmpdir(), "forge-repair-quotes-"));
      roots.push(root);
      const native = windowsPrivateFiles();
      const guard = privateFileGuard(native);
      guard.directory(root);
      const path = join(root, `file${quote}; Write-Output INJECTED; ${quote}`);
      const sentinel = join(root, "sentinel");
      writeFileSync(path, "target");
      writeFileSync(sentinel, "sentinel");
      const sentinelAcl = native.read(sentinel);
      native.protect(path, `D:P(A;;FA;;;${native.sid})(A;;FR;;;WD)`);
      let message = "";
      try {
        guard.file(path);
      } catch (error) {
        message = String(error);
      }
      const command = message.split(/Repair in PowerShell:\s*/)[1];
      expect(command).toBeDefined();
      return {
        name: `quote U+${quote.charCodeAt(0).toString(16)}`,
        command: command!,
        path,
        sentinel,
        sentinelAcl,
        guard,
        native,
      };
    });
    expect(cases).toHaveLength(5);
    const launches = batch.launches;
    const runs = await batch.runEach(shell, cases, 15000);
    // One launch when nothing stalls; each timed-out or crashed case that has a later case that
    // actually ran costs exactly one more launch. Not-run cases cost none.
    const relaunched = runs.flatMap((run, index) =>
      (run.reason === "timeout" || run.reason === "exit") &&
      runs[index + 1] !== undefined &&
      runs[index + 1]!.reason !== "not-run"
        ? [index]
        : [],
    );
    expect(batch.launches - launches).toBe(1 + relaunched.length);
    expect(runs).toHaveLength(cases.length);
    return cases.map((entry, index) => ({ ...entry, run: runs[index]! }));
  }
  let prepared: ReturnType<typeof prepare> | undefined;
  for (const [index, quote] of quotes.entries()) {
    windowsTest(
      `repair is literal and portable in ${shell} for quote U+${quote.charCodeAt(0).toString(16)}`,
      async () => {
        prepared ??= prepare();
        const { run, path, sentinel, sentinelAcl, guard, native, name } = (
          await prepared
        )[index]!;
        expect(run.name).toBe(name);
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).not.toContain("INJECTED");
        guard.file(path);
        expect(readFileSync(path, "utf8")).toBe("target");
        expect(native.read(sentinel)).toBe(sentinelAcl);
        expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
      },
    );
  }
}
expect(caseNames).toHaveLength(2 + 5 * shells.length);
expect(caseNames.join("\n")).toBe(
  [
    "borrowed folder refusal gives guidance without changing its tree or siblings",
    "PowerShell timeout names the running command phase",
    ...shells.flatMap((shell) =>
      ["27", "2018", "2019", "201a", "201b"].map(
        (code) =>
          `repair is literal and portable in ${shell} for quote U+${code}`,
      ),
    ),
  ].join("\n"),
);
