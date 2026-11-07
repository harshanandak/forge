import { expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cleanupAttribution } from "./cleanup-attribution.ts";

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
          cleanupAttribution(root, () => {
            throw original;
          });
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
            `Handle did not name holder ${child.pid} of ${path}. Snapshot: ${original.message}\nHandles of the child: ${listing.stdout || listing.stderr}`,
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
