import { withCliOwnerApproval } from "../fixtures/owner-approval.mjs";
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../src/generated/types.ts";

setDefaultTimeout(30_000);

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");

function fixture(kind: "outside" | "internal" | "plain" | "missing") {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-state-root-"));
  const root = join(sandbox, "project");
  const checkout = join(sandbox, "checkout");
  const device = join(sandbox, "device");
  const target =
    kind === "outside" ? join(sandbox, "project-other") : join(root, "..state");
  function git(...args: string[]) {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  try {
    mkdirSync(root);
    git("init");
    git(
      "-c",
      "user.name=Forge Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    git("worktree", "add", "--detach", checkout, "HEAD");
    // A linked checkout reads its own config but opens the main checkout's state.
    // This reaches the state boundary independently of config's existing refusal.
    mkdirSync(join(checkout, ".forge"));
    writeFileSync(
      join(checkout, ".forge/config.yaml"),
      "blocks:\n  work: {}\n",
    );
    if (kind === "plain") mkdirSync(join(root, ".forge"));
    if (kind === "outside" || kind === "internal") {
      mkdirSync(target);
      symlinkSync(target, join(root, ".forge"), "junction");
    }
    return {
      root,
      device,
      target,
      call: withCliOwnerApproval((args: string[]): ResultEnvelope => {
        const result = spawnSync("node", [bin, ...args], {
          cwd: checkout,
          env: {
            ...process.env,
            FORGE_DEVICE_ROOT: device,
            FORGE_SESSION: "state-root-test",
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBeNull();
        const envelope = JSON.parse(result.stdout) as ResultEnvelope;
        expect(result.status, result.stdout + result.stderr).toBe(
          envelope.ok ? 0 : 1,
        );
        return envelope;
      }),
      close() {
        rmSync(sandbox, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(sandbox, { recursive: true, force: true });
    throw error;
  }
}

for (const args of [
  ["store", "reinit"],
  ["issue", "create", "--title", "Contained issue"],
]) {
  test(`${args.slice(0, 2).join(" ")} refuses an outside .forge before creating state`, () => {
    const f = fixture("outside");
    try {
      expect(f.call(args, 1)).toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL",
          message:
            'refusing ".forge/state.sqlite": symlink target is outside the project root',
        },
      });
      expect(existsSync(join(f.target, "state.sqlite"))).toBe(false);
      expect(readdirSync(f.target)).toEqual([]);
    } finally {
      f.close();
    }
  });
}

for (const kind of ["internal", "plain", "missing"] as const) {
  test(`a ${kind} .forge supports recovery and issue writes with a separate device store`, () => {
    const f = fixture(kind);
    try {
      expect(f.call(["store", "reinit"])).toMatchObject({ ok: true });
      expect(
        f.call(["issue", "create", "--title", "Contained issue"]),
      ).toMatchObject({ ok: true, result: { title: "Contained issue" } });
      expect(existsSync(join(f.root, ".forge/state.sqlite"))).toBe(true);
      expect(existsSync(join(f.device, "records.sqlite"))).toBe(true);
      if (kind === "internal")
        expect(existsSync(join(f.target, "state.sqlite"))).toBe(true);
    } finally {
      f.close();
    }
  });
}

test("invalid reinit returns its validation error without creating an approval request", () => {
  const f = fixture("outside");
  try {
    const result = f.call(["store", "reinit"], 1);
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(result.result).toBeUndefined();
    expect(existsSync(f.device)).toBe(false);
  } finally {
    f.close();
  }
});
