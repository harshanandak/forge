import { expect, setDefaultTimeout, test } from "bun:test";
import { windowsEvidence } from "./cleanup-attribution.ts";

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
