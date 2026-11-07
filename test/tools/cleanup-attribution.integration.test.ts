import { expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cleanupAttribution,
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
  run: AttributionRunner,
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
    const processes = Array.from({ length: 60 }, (_, index) => ({
      pid: 100 + index,
      parent: 1,
      parentName: "bun.exe",
      name: "bun.exe",
      command: `bun ${"x".repeat(200)}`,
    }));
    processes.push(
      {
        pid: 7,
        parent: 1,
        parentName: "bun.exe",
        name: "node.exe",
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
