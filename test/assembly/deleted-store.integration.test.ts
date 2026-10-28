import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");

function project() {
  const work = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge-deleted-store-")),
  );
  const root = join(work, "project");
  const device = join(work, "device");
  mkdirSync(join(root, ".forge"), { recursive: true });
  // Config is written before the first state write; it alone cannot prove a lost store.
  writeFileSync(join(root, ".forge/config.yaml"), "blocks:\n  work: {}\n");
  return {
    work,
    root,
    device,
    async reinit(): Promise<ResultEnvelope> {
      const assembly = await createAssembly({ root, deviceRoot: device });
      try {
        return await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: "owner-reinit",
          op: "store.reinit",
          input: {},
          caller: "human",
          context: localContext(assembly, {
            kind: "human",
            id: "fixture-owner",
          }),
        });
      } finally {
        await assembly.close();
      }
    },
    cli(args: string[], status: number): ResultEnvelope {
      const result = spawnSync("node", [bin, ...args], {
        cwd: root,
        env: {
          ...process.env,
          FORGE_DEVICE_ROOT: device,
          FORGE_SESSION: "deleted-store",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(status);
      return JSON.parse(result.stdout) as ResultEnvelope;
    },
  };
}

test("fresh configured project reads still create no project or device store", () => {
  const p = project();
  try {
    expect(p.cli(["issue", "list"], 0)).toMatchObject({
      ok: true,
      result: { items: [] },
    });
    expect(p.cli(["issue", "show", "project-1"], 3)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(readdirSync(join(p.root, ".forge"))).toEqual(["config.yaml"]);
    expect(existsSync(p.device)).toBe(false);
  } finally {
    rmSync(p.work, { recursive: true, force: true });
  }
}, 60_000);

for (const lost of ["database", "directory"] as const) {
  for (const read of ["list", "show"] as const) {
    test(`a missing established ${lost} refuses ${read} and supports explicit recovery`, async () => {
      const p = project();
      const path = join(p.root, ".forge/state.sqlite");
      const saved = join(p.work, "backup");
      try {
        expect(
          p.cli(["issue", "create", "--title", "Original"], 0),
        ).toMatchObject({ ok: true, result: { id: "project-1" } });
        const config = readFileSync(join(p.root, ".forge/config.yaml"));
        if (lost === "database") {
          copyFileSync(path, saved);
          rmSync(path);
        } else {
          renameSync(join(p.root, ".forge"), saved);
        }
        if (lost === "directory") {
          mkdirSync(join(p.root, ".forge"));
          writeFileSync(join(p.root, ".forge/config.yaml"), config);
        }
        const args =
          read === "list" ? ["issue", "list"] : ["issue", "show", "project-1"];
        const result = p.cli(args, 1);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", retry: "never" },
        });
        if (result.ok) throw Error("Expected missing store failure");
        expect(result.error.message).toBe(
          `Missing Forge store at ${path}. Fix: restore it from a backup, or run forge store reinit to start a new empty store.`,
        );
        expect(existsSync(path)).toBe(false);
        for (const write of [
          ["issue", "claim", "project-1"],
          ["issue", "create", "--title", "Accidental reset"],
        ]) {
          expect(p.cli(write, 1)).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: result.error.message },
          });
          expect(existsSync(path)).toBe(false);
        }
        // Restoring the database recovers the original data without re-initializing.
        if (lost === "database") copyFileSync(saved, path);
        else {
          rmSync(join(p.root, ".forge"), { recursive: true });
          renameSync(saved, join(p.root, ".forge"));
        }
        expect(p.cli(["issue", "show", "project-1"], 0)).toMatchObject({
          ok: true,
          result: { title: "Original" },
        });
        rmSync(path);
        // Recovery creates only the empty store, never an incidental issue.
        expect(p.cli(["store", "reinit"], 1)).toMatchObject({
          ok: false,
          error: { code: "HUMAN_REQUIRED" },
        });
        expect(existsSync(path)).toBe(false);
        expect(await p.reinit()).toMatchObject({
          ok: true,
          op: "store.reinit",
        });
        expect(p.cli(["issue", "list"], 0)).toMatchObject({
          ok: true,
          result: { items: [] },
        });
      } finally {
        rmSync(p.work, { recursive: true, force: true });
      }
    }, 90_000);
  }
}

test("store reinit refuses an existing store without changing its records", async () => {
  const p = project();
  try {
    p.cli(["issue", "create", "--title", "Keep me"], 0);
    expect(await p.reinit()).toMatchObject({
      ok: false,
      error: { code: "INPUT_CONFLICT" },
    });
    expect(p.cli(["issue", "show", "project-1"], 0)).toMatchObject({
      ok: true,
      result: { title: "Keep me" },
    });
  } finally {
    rmSync(p.work, { recursive: true, force: true });
  }
}, 60_000);

test("store reinit is universally available without an enabled block", async () => {
  const p = project();
  try {
    writeFileSync(join(p.root, ".forge/config.yaml"), "{}\n");
    expect(await p.reinit()).toMatchObject({
      ok: true,
      op: "store.reinit",
    });
    expect(existsSync(join(p.root, ".forge/state.sqlite"))).toBe(true);
  } finally {
    rmSync(p.work, { recursive: true, force: true });
  }
}, 60_000);

test("the removed recovery flag cannot start an MCP server", () => {
  const p = project();
  try {
    expect(p.cli(["--reinitialize-store", "--mcp"], 3)).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
    expect(existsSync(join(p.root, ".forge/state.sqlite"))).toBe(false);
  } finally {
    rmSync(p.work, { recursive: true, force: true });
  }
}, 60_000);
