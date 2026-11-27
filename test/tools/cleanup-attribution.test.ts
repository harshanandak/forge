import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powerShellArgs } from "../powershell.ts";
import { HOST_EVIDENCE, windowsEvidence } from "./cleanup-attribution.ts";

setDefaultTimeout(30_000);

test("a failed host query keeps status, signal, code and the stalled probe in the evidence", () => {
  const evidence = windowsEvidence("root", "root", () => ({
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr:
      "host-probe start cim\nhost-probe end cim 40\nhost-probe start filters\n",
    error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  })) as { hostError?: unknown };
  const hostError = String(evidence.hostError);
  expect(hostError).toContain("ETIMEDOUT");
  expect(hostError).toContain("SIGTERM");
  expect(hostError).toContain("host-probe start filters");
}, 5_000);

test("a long host stderr is cut to its last 1000 characters in the evidence", () => {
  const stderr = `START-${"x".repeat(2000)}-END`;
  const evidence = windowsEvidence("root", "root", () => ({
    status: 1,
    signal: null,
    stdout: "",
    stderr,
    error: Object.assign(new Error("host query failed"), {
      code: "ETIMEDOUT",
    }),
  })) as { hostError?: unknown };
  const hostError = String(evidence.hostError);
  expect(hostError).toContain("-END");
  expect(hostError).not.toContain("START-");
  expect(hostError).toContain(stderr.slice(-1000));
}, 5_000);

test.skipIf(process.platform !== "win32")(
  "the host evidence reports each probe on stderr and keeps stdout as one JSON line",
  () => {
    const root = mkdtempSync(join(tmpdir(), "forge-host-probe-"));
    writeFileSync(join(root, "kept.txt"), "kept");
    try {
      const result = spawnSync(
        "powershell.exe",
        powerShellArgs(HOST_EVIDENCE),
        {
          encoding: "utf8",
          env: { ...process.env, FORGE_CLEANUP_ROOT: root },
          timeout: 60_000,
          windowsHide: true,
        },
      );
      expect(result.status).toBe(0);
      for (const name of ["cim", "filters", "volume", "defender", "search"])
        expect(result.stderr).toContain(`host-probe start ${name}`);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0]!)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
