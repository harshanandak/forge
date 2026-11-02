import { expect, test } from "bun:test";
import { hash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(mismatch = false) {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  const tarball = join(dir, "package.tgz");
  writeFileSync(tarball, "tested bytes");
  writeFileSync(
    `${tarball}.sha256`,
    hash("sha256", mismatch ? "other" : "tested bytes"),
  );
  const calls: string[][] = [];
  const stdin: Uint8Array[] = [];
  const run = (args: string[], input?: Uint8Array) => {
    calls.push(args);
    if (input) stdin.push(input);
    return JSON.stringify({ name: "forge-workflow", version: "0.1.0-dev.0" });
  };
  return {
    tarball,
    calls,
    stdin,
    run,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("matching sidecar dry-runs only the verified tarball", async () => {
  const f = fixture();
  try {
    const { dryRun } = await import("../../../tools/release/dry-run.ts");
    expect(
      await dryRun(f.tarball, {
        run: f.run,
        fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      }),
    ).toBe("0.1.0-dev.0");
    expect(Buffer.concat(f.stdin).toString()).toBe("tested bytes");
    expect(f.calls).toEqual([
      ["tar", "-xzOf", "-", "package/package.json"],
      [
        "npm",
        "publish",
        f.tarball,
        "--dry-run",
        "--provenance",
        "--tag",
        "next",
        "--access",
        "public",
        "--ignore-scripts",
      ],
    ]);
  } finally {
    f.cleanup();
  }
}, 1000);

test("mismatching sidecar fails before any command or registry request", async () => {
  const f = fixture(true);
  try {
    const { dryRun } = await import("../../../tools/release/dry-run.ts");
    await expect(
      dryRun(f.tarball, {
        run: f.run,
        fetch: () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toThrow("sha256 mismatch");
    expect(f.calls).toEqual([]);
  } finally {
    f.cleanup();
  }
}, 1000);

for (const status of [200, 403, 500]) {
  test(`registry status ${status} prevents dry-run`, async () => {
    const f = fixture();
    try {
      const { dryRun } = await import("../../../tools/release/dry-run.ts");
      await expect(
        dryRun(f.tarball, {
          run: f.run,
          fetch: () => Promise.resolve(new Response(null, { status })),
        }),
      ).rejects.toThrow(
        status === 200 ? "already published" : `registry HTTP ${status}`,
      );
      expect(f.calls).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  }, 1000);
}

test("offline local check is explicit; CI fails closed", async () => {
  const f = fixture();
  try {
    const { dryRun } = await import("../../../tools/release/dry-run.ts");
    const offline = () => Promise.reject(new Error("offline"));
    await expect(
      dryRun(f.tarball, { run: f.run, fetch: offline }),
    ).resolves.toBe("0.1.0-dev.0");
    await expect(
      dryRun(f.tarball, { run: f.run, fetch: offline, requireRegistry: true }),
    ).rejects.toThrow("offline");
  } finally {
    f.cleanup();
  }
}, 1000);
