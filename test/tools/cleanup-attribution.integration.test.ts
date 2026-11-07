import { expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { powerShellArgs } from "../powershell.ts";
import {
  cleanupAttribution,
  HOST_EVIDENCE,
  type AttributionRunner,
  type CleanupInspector,
} from "./cleanup-attribution.ts";

setDefaultTimeout(30_000);

for (const kind of ["file", "directory"])
  test.skipIf(process.platform !== "win32")(
    `cleanup snapshot names a ${kind} holder`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "forge-holder-"));
      const path = kind === "file" ? join(root, "held.txt") : root;
      if (kind === "file") writeFileSync(path, "held");
      const child = spawn(
        process.execPath,
        [
          "-e",
          `${kind === "file" ? "require('node:fs').openSync(process.argv[1], 'r');" : "require('node:fs').watch(process.argv[1]);"} console.log('ready'); setInterval(() => {}, 1000)`,
          path,
        ],
        { cwd: root, stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
      );
      const closed = once(child, "close");
      try {
        // The directory child holds an explicit watch handle on top of its cwd, so
        // the snapshot does not depend on how Handle lists a cwd handle.
        await Promise.race([
          once(child.stdout, "data"),
          closed.then(() => {
            throw new Error("holder child exited before it was ready");
          }),
        ]);
        const original = Object.assign(new Error("cleanup refused"), {
          code: "EBUSY",
          path,
        });
        let caught: unknown;
        try {
          // The host evidence also names the child pid; keep it out of this Handle assertion.
          cleanupAttribution(
            root,
            () => {
              throw original;
            },
            undefined,
            { inspect: () => undefined },
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(original);
        const tool = process.env.FORGE_HANDLE_EXE;
        const unavailable = process.env.FORGE_HANDLE_UNAVAILABLE;
        if (process.env.CI)
          expect(Boolean(tool) !== Boolean(unavailable)).toBe(true);
        if (!tool || unavailable) {
          expect(original.message).toContain(
            unavailable || "handle unavailable: not configured",
          );
          expect(original.message).toContain('"status":null');
          expect(original.message).not.toContain('"status":0');
          return;
        }
        if (!original.message.includes(String(child.pid))) {
          // Name what the child really holds, so a miss is diagnosable from the log.
          const listing = spawnSync(
            tool,
            ["-accepteula", "-nobanner", "-a", "-p", String(child.pid)],
            { encoding: "utf8", timeout: 10_000, windowsHide: true },
          );
          throw new Error(
            `Handle did not name holder ${child.pid} of ${path}. Snapshot: ${original.message}\nHandles of the child (status ${listing.status}, error ${listing.error?.message ?? "none"}): ${listing.stdout || listing.stderr}`,
          );
        }
        expect(original.message).toContain(basename(process.execPath));
        expect(original.message).toContain(path.replaceAll("\\", "\\\\"));
        expect(original.message).toMatch(/"at":"\d{4}-\d\d-\d\dT/);
        expect(original.message).toContain('"status":0');
      } finally {
        child.kill();
        await closed;
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

test.skipIf(process.platform !== "win32")(
  "attribution failure preserves the original cleanup error",
  () => {
    const original = Object.assign(new Error("cleanup refused"), {
      code: "EPERM",
      path: "held",
    });
    let caught: unknown;
    try {
      cleanupAttribution(
        "root",
        () => {
          throw original;
        },
        () => {
          throw new Error("snapshot unavailable");
        },
        { tool: "fixture-handle", unavailable: "" },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(original.message).toContain("snapshot unavailable");
    expect(original.message).toContain("attribution failed");
  },
  1_000,
);

test.skipIf(process.platform !== "win32")(
  "a Handle run that finds no holder says so instead of an empty failure",
  () => {
    const original = Object.assign(new Error("cleanup refused"), {
      code: "EBUSY",
      path: "held",
    });
    try {
      cleanupAttribution(
        "root",
        () => {
          throw original;
        },
        () => ({
          status: 1,
          stdout: "No matching handles found.\r\n",
          stderr: "",
        }),
        { tool: "fixture-handle", unavailable: "" },
      );
    } catch {
      // The original cleanup error is rethrown after the snapshot.
    }
    const [snapshot] = JSON.parse(
      original.message.split("Cleanup attribution: ")[1]!,
    ) as { failure: string }[];
    expect(snapshot!.failure).toContain("No matching handles found");
  },
  1_000,
);

function refuse(
  root: string,
  run: AttributionRunner = spawnSync,
  inspect?: CleanupInspector,
) {
  const original = Object.assign(new Error("cleanup refused"), {
    code: "EBUSY",
    path: root,
  });
  try {
    cleanupAttribution(
      root,
      () => {
        throw original;
      },
      run,
      { tool: "fixture-handle", unavailable: "", ...(inspect && { inspect }) },
    );
  } catch (error) {
    expect(error).toBe(original);
  }
  const [, line] = original.message.split("Cleanup evidence: ");
  return {
    message: original.message,
    evidence: JSON.parse(line!.split("\n")[0]!) as Record<string, unknown>,
  };
}

test.skipIf(process.platform !== "win32")(
  "cleanup evidence names what remains under the root, the host state and the folder search",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-evidence-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "kept.txt"), "kept");
    const handleTargets: string[] = [];
    try {
      const { evidence } = refuse(root, (command, args) => {
        if (command !== "fixture-handle")
          return {
            status: 0,
            stdout: JSON.stringify({
              processes: [{ pid: 4242, name: "git.exe" }],
              filters: "WdFilter",
            }),
          };
        handleTargets.push(args.at(-1)!);
        return { status: 1, stdout: "No matching handles found.\r\n" };
      });
      expect(evidence).toMatchObject({
        errorIsRoot: true,
        rootExists: true,
        probeFailures: [],
        host: { processes: [{ pid: 4242 }], filters: "WdFilter" },
      });
      expect((evidence.remaining as string[]).sort()).toEqual([
        "nested",
        join("nested", "kept.txt"),
      ]);
      // Handle matches by substring, so the bare folder name catches a differently spelled path.
      expect(handleTargets).toContain(basename(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "a failed host query is recorded in the evidence and the original error survives",
  () => {
    const missing = join(
      tmpdir(),
      `forge-missing-${process.pid}-${Date.now()}`,
    );
    const { evidence } = refuse(missing, () => {
      throw new Error("host query unavailable");
    });
    expect(evidence).toMatchObject({ errorIsRoot: true, rootExists: false });
    expect(String(evidence.hostError)).toContain("host query unavailable");
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "a large host response still gives one valid evidence line with the filters and omitted counts",
  () => {
    const missing = join(tmpdir(), `forge-large-${process.pid}-${Date.now()}`);
    const processes: Record<string, unknown>[] = Array.from(
      { length: 60 },
      (_, index) => ({
        pid: 100 + index,
        parent: 1,
        parentName: "bun.exe",
        name: "bun.exe",
        command: `bun ${"x".repeat(200)}`,
      }),
    );
    processes.push(
      {
        pid: 7,
        parent: 1,
        parentName: "bun.exe",
        name: "node.exe",
        matchesRoot: true,
        command: missing,
      },
      {
        pid: 99,
        parent: 5,
        parentName: "bun.exe",
        name: "conhost.exe",
        command: "conhost",
      },
    );
    const { evidence, message } = refuse(missing, (command) =>
      command !== "fixture-handle"
        ? {
            status: 0,
            stdout: JSON.stringify({
              processes,
              filters: `WdFilter${" x".repeat(3_000)}`,
              volume: `instances${" y".repeat(3_000)}`,
            }),
          }
        : { status: 1, stdout: "No matching handles found.\r\n" },
    );
    const host = evidence.host as {
      processes: { pid: number; parentName?: string }[];
      filters: string;
      volume: string;
    };
    expect(host.filters).toContain("WdFilter");
    expect(host.volume).toContain("instances");
    // Root-named and conhost processes survive the cap, in front of the rest.
    expect(host.processes.slice(0, 2).map((item) => item.pid)).toEqual([7, 99]);
    expect(host.processes[1]!.parentName).toBe("bun.exe");
    expect(evidence.processesOmitted).toBeGreaterThan(0);
    expect(
      message.split("Cleanup evidence: ")[1]!.split("\n")[0]!.length,
    ).toBeLessThan(12_000);
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "an evidence value that cannot be serialized never replaces the original error",
  () => {
    const missing = join(tmpdir(), `forge-loop-${process.pid}-${Date.now()}`);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const { evidence } = refuse(
      missing,
      () => ({ status: 1, stdout: "No matching handles found.\r\n" }),
      () => loop,
    );
    expect(String(evidence.inspectError)).toContain("TypeError");
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "the evidence line records whether a second remove succeeds and still throws the original error",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-second-"));
    writeFileSync(join(root, "kept.txt"), "kept");
    const original = Object.assign(new Error("cleanup refused"), {
      code: "EBUSY",
      path: root,
    });
    let calls = 0;
    let caught: unknown;
    try {
      cleanupAttribution(
        root,
        () => {
          calls++;
          if (calls === 1) throw original;
          rmSync(root, { recursive: true, force: true });
        },
        () => ({ status: 1, stdout: "No matching handles found.\r\n" }),
        { tool: "fixture-handle", unavailable: "", inspect: () => ({}) },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(calls).toBe(2);
    const line = original.message.split("Cleanup evidence: ")[1]!;
    const evidence = JSON.parse(line.split("\n")[0]!) as Record<
      string,
      unknown
    >;
    expect(evidence.secondAttempt).toBe("removed");
    expect(evidence.secondAttemptMs).toBeGreaterThanOrEqual(450);
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "a second remove that fails again records its error code",
  () => {
    const root = join(
      tmpdir(),
      `forge-second-busy-${process.pid}-${Date.now()}`,
    );
    const original = Object.assign(new Error("cleanup refused"), {
      code: "EBUSY",
      path: root,
    });
    let calls = 0;
    let caught: unknown;
    try {
      cleanupAttribution(
        root,
        () => {
          calls++;
          throw calls === 1
            ? original
            : Object.assign(new Error("still refused"), { code: "EPERM" });
        },
        () => ({ status: 1, stdout: "No matching handles found.\r\n" }),
        { tool: "fixture-handle", unavailable: "", inspect: () => ({}) },
      );
    } catch (error) {
      caught = error;
    }
    // The first error is the one that surfaces; the second only becomes evidence.
    expect(caught).toBe(original);
    const line = original.message.split("Cleanup evidence: ")[1]!;
    const evidence = JSON.parse(line.split("\n")[0]!) as Record<
      string,
      unknown
    >;
    expect(evidence.secondAttempt).toBe("EPERM");
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "a second remove whose failure cannot be described never replaces the original error",
  () => {
    const root = join(
      tmpdir(),
      `forge-second-opaque-${process.pid}-${Date.now()}`,
    );
    const original = Object.assign(new Error("cleanup refused"), {
      code: "EBUSY",
      path: root,
    });
    let calls = 0;
    let caught: unknown;
    try {
      cleanupAttribution(
        root,
        () => {
          calls++;
          // A null-prototype object has no code and cannot become a string.
          throw calls === 1 ? original : Object.create(null);
        },
        () => ({ status: 1, stdout: "No matching handles found.\r\n" }),
        { tool: "fixture-handle", unavailable: "", inspect: () => ({}) },
      );
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(2);
    expect(caught).toBe(original);
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "a run without host evidence still records whether a second remove succeeds",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-second-bare-"));
    writeFileSync(join(root, "kept.txt"), "kept");
    const original = Object.assign(new Error("cleanup refused"), {
      code: "EBUSY",
      path: root,
    });
    let calls = 0;
    try {
      cleanupAttribution(
        root,
        () => {
          calls++;
          if (calls === 1) throw original;
          rmSync(root, { recursive: true, force: true });
        },
        () => ({ status: 1, stdout: "No matching handles found.\r\n" }),
        { tool: "fixture-handle", unavailable: "", inspect: () => undefined },
      );
    } catch (error) {
      expect(error).toBe(original);
    }
    expect(calls).toBe(2);
    const line = original.message.split("Cleanup evidence: ")[1]!;
    const evidence = JSON.parse(line.split("\n")[0]!) as Record<
      string,
      unknown
    >;
    expect(evidence.secondAttempt).toBe("removed");
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "the host query lists a root-named process first, flags it, and applies the cap in PowerShell",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-procs-"));
    // The root sits past character 200 of the command line, so only a flag from PowerShell finds it.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "console.log('ready'); setInterval(() => {}, 1000)",
        "x".repeat(300),
        root,
      ],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    const closed = once(child, "close");
    try {
      await Promise.race([
        once(child.stdout, "data"),
        closed.then(() => {
          throw new Error("child exited before it was ready");
        }),
      ]);
      const result = spawnSync(
        "powershell.exe",
        powerShellArgs(HOST_EVIDENCE),
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FORGE_CLEANUP_ROOT: root,
            FORGE_CLEANUP_PROCESS_CAP: "1",
          },
          timeout: 60_000,
          windowsHide: true,
        },
      );
      expect(result.status).toBe(0);
      const host = JSON.parse(result.stdout) as {
        processes: { pid: number; matchesRoot?: boolean; command: string }[];
      };
      // With a cap of one, only a sort that runs before the cap keeps the root-named process.
      expect(host.processes).toHaveLength(1);
      expect(host.processes[0]!.pid).toBe(child.pid!);
      expect(host.processes[0]!.matchesRoot).toBe(true);
      expect(host.processes[0]!.command.length).toBeLessThanOrEqual(200);
      expect(host.processes[0]!.command).not.toContain(root);
    } finally {
      child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

test.skipIf(process.platform !== "win32")(
  "an evidence line that is too large still keeps the scalars and the probe results",
  () => {
    const root = join(tmpdir(), `forge-huge-${process.pid}-${Date.now()}`);
    const { evidence } = refuse(
      root,
      () => ({ status: 1, stdout: "No matching handles found.\r\n" }),
      () => ({
        root,
        rootExists: true,
        errorIsRoot: true,
        probeFailures: [{ path: "held.txt", code: "EBUSY" }],
        padding: "x".repeat(20_000),
      }),
    );
    expect(evidence.evidenceTooLarge).toBeGreaterThan(12_000);
    expect(evidence).toMatchObject({
      root,
      rootExists: true,
      errorIsRoot: true,
      probeFailures: [{ path: "held.txt", code: "EBUSY" }],
    });
    expect(evidence.padding).toBeUndefined();
  },
  5_000,
);

test.skipIf(process.platform !== "win32")(
  "the probe names a holder that allows reads but denies delete sharing",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-share-"));
    const path = join(root, "held.txt");
    writeFileSync(path, "held");
    // Node always shares delete, so PowerShell opens the file with FileShare.Read only.
    const holder = spawn(
      "powershell.exe",
      powerShellArgs(
        "$held = [IO.File]::Open($env:FORGE_HELD, 'Open', 'Read', 'Read'); 'ready'; [Console]::Out.Flush(); Start-Sleep -Seconds 60",
      ),
      {
        env: { ...process.env, FORGE_HELD: path },
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      },
    );
    const closed = once(holder, "close");
    try {
      await Promise.race([
        once(holder.stdout, "data"),
        closed.then(() => {
          throw new Error("holder exited before it was ready");
        }),
      ]);
      const { evidence } = refuse(root, () => ({
        status: 1,
        stdout: "No matching handles found.\r\n",
      }));
      const failures = evidence.probeFailures as {
        path: string;
        code: string;
      }[];
      expect(failures.map((failure) => failure.path)).toEqual(["held.txt"]);
      expect(failures[0]!.code).toMatch(/^E(?:BUSY|PERM|ACCES)$/);
    } finally {
      holder.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(process.platform !== "win32")(
  "the host evidence script parses as PowerShell",
  () => {
    const result = spawnSync(
      "powershell.exe",
      powerShellArgs(
        "$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:FORGE_PS_SCRIPT, [ref]$tokens, [ref]$errors); Write-Output ($errors.Count.ToString() + ' ' + (($errors | ForEach-Object { $_.Message }) -join '; '))",
      ),
      {
        encoding: "utf8",
        env: { ...process.env, FORGE_PS_SCRIPT: HOST_EVIDENCE },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    expect(result.status).toBe(0);
    // The line is the parse error count followed by their messages.
    expect(result.stdout.trim()).toBe("0");
  },
  60_000,
);

test.skipIf(process.platform !== "win32")(
  "the real host query returns processes and the filter state without a host error",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-host-"));
    writeFileSync(join(root, "kept.txt"), "kept");
    try {
      const { evidence } = refuse(root);
      expect(evidence.hostError).toBeUndefined();
      const host = evidence.host as Record<string, unknown>;
      expect(Array.isArray(host.processes)).toBe(true);
      expect("filters" in host || "filterError" in host).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

for (const reason of ["checksum mismatch", "download failed", "not configured"])
  test.skipIf(process.platform !== "win32")(
    `unavailable Handle reports ${reason} without executing it`,
    () => {
      const original = Object.assign(new Error("cleanup refused"), {
        code: "EBUSY",
        path: "held",
      });
      const unavailable = `handle unavailable: ${reason}`;
      let calls = 0;
      let caught: unknown;
      try {
        cleanupAttribution(
          "root",
          () => {
            throw original;
          },
          () => {
            calls++;
            throw new Error("must not execute Handle");
          },
          {
            tool: reason === "not configured" ? "" : "unverified-handle.exe",
            unavailable: reason === "not configured" ? "" : unavailable,
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(original);
      expect(calls).toBe(0);
      expect(original.message).toContain("cleanup refused");
      expect(original.message).toContain(unavailable);
    },
    1_000,
  );
