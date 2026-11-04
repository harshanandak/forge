import { expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
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
          `${kind === "file" ? "require('node:fs').openSync(process.argv[1], 'r');" : ""} console.log('ready'); setInterval(() => {}, 1000)`,
          path,
        ],
        { cwd: root, stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
      );
      const closed = once(child, "close");
      try {
        // A Windows directory is held by cwd; opening it as a file is unnecessary.
        await once(child.stdout, "data");
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
        if (process.env.FORGE_HANDLE_UNAVAILABLE) {
          expect(original.message).toContain(
            process.env.FORGE_HANDLE_UNAVAILABLE,
          );
          return;
        }
        expect(original.message).toContain(String(child.pid));
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

for (const reason of ["checksum mismatch", "download failed"])
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
          { tool: "unverified-handle.exe", unavailable },
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
