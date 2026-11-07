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
test(
  "a stalled batch case fails alone and the cases after it still run",
  async () => {
    const commandStart = "FORGE_COMMAND_START:2026-11-03T00:00:00.000Z\n";
    // Launch 0 stalls inside "stalled" (case 1). Launch 1 runs the two cases after it.
    const outputs = [
      `${commandStart}FORGE_CASE_START:0\nfirst\nFORGE_CASE_END:0:0\nFORGE_CASE_START:1\n`,
      `${commandStart}FORGE_CASE_START:0\nthird\nFORGE_CASE_END:0:0\nFORGE_CASE_START:1\nfourth\nFORGE_CASE_END:1:1\n`,
    ];
    const scripts: string[] = [];
    const simulated = powerShellBatch((_shell, args) => {
      const launch = scripts.push(args.at(-1)!) - 1;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => child.emit("close", null),
      });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(outputs[launch]!));
        if (launch > 0) child.emit("close", 0);
      });
      return child;
    });
    const outcomes = await simulated.runEach(
      "powershell.exe",
      [
        { name: "first", command: "Write-Output first" },
        { name: "stalled", command: "Start-Sleep -Seconds 60" },
        { name: "third", command: "Write-Output third" },
        { name: "fourth", command: "Write-Output fourth" },
      ],
      0,
    );
    expect(outcomes.map(({ name }) => name)).toEqual([
      "first",
      "stalled",
      "third",
      "fourth",
    ]);
    expect(outcomes[0]).toMatchObject({ status: 0, stdout: "first\n" });
    expect(outcomes[1]!.status).not.toBe(0);
    expect(outcomes[1]!.stderr).toContain(
      "timeout; phase=command; case=stalled;",
    );
    expect(outcomes[2]).toMatchObject({ status: 0, stdout: "third\n" });
    expect(outcomes[3]).toMatchObject({ status: 1, stdout: "fourth\n" });
    expect(simulated.launches).toBe(2);
    expect(scripts[1]).toContain("Write-Output third");
    expect(scripts[1]).toContain("Write-Output fourth");
    expect(scripts[1]).not.toContain("Write-Output first");
    expect(scripts[1]).not.toContain("Start-Sleep");
  },
  5000,
);
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
    const runs = await batch.run(shell, cases, 15000);
    expect(batch.launches - launches).toBe(1);
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
