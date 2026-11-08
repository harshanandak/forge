import { withCliOwnerApproval } from "../fixtures/owner-approval.mjs";
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../../src/generated/types.ts";

setDefaultTimeout(30_000);

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-project-init-"));
  const root = join(sandbox, "project");
  const device = join(sandbox, "device");
  mkdirSync(root);
  const init = spawnSync("git", ["init"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  expect(init.status, init.stdout + init.stderr).toBe(0);
  return {
    root,
    manifest: join(root, ".forge", "project.json"),
    call: withCliOwnerApproval((args: string[]): ResultEnvelope => {
      const result = spawnSync("node", [bin, ...args], {
        cwd: root,
        env: {
          ...process.env,
          FORGE_DEVICE_ROOT: device,
          FORGE_SESSION: "project-init-test",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBeNull();
      return JSON.parse(result.stdout) as ResultEnvelope;
    }),
    close() {
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

test("project init writes the manifest with a new random id", () => {
  const f = fixture();
  try {
    const made = f.call(["project", "init"]);
    expect(made).toMatchObject({ ok: true, op: "project.init" });
    const { id } = (made as { result: { id: string } }).result;
    expect(id).toMatch(V4);
    expect(JSON.parse(readFileSync(f.manifest, "utf8"))).toEqual({
      schema: 1,
      id,
    });
  } finally {
    f.close();
  }
});

test("project init refuses when a manifest exists and never rewrites it", () => {
  const f = fixture();
  try {
    f.call(["project", "init"]);
    const before = readFileSync(f.manifest);
    const again = f.call(["project", "init"], 1);
    expect(again).toMatchObject({
      ok: false,
      error: { code: "PROJECT_MANIFEST_EXISTS" },
    });
    expect(readFileSync(f.manifest).equals(before)).toBe(true);
    const named = f.call(
      ["project", "init", "--input", JSON.stringify({ name: "other" })],
      1,
    );
    expect(named).toMatchObject({
      ok: false,
      error: { code: "PROJECT_MANIFEST_EXISTS" },
    });
    expect(readFileSync(f.manifest).equals(before)).toBe(true);
  } finally {
    f.close();
  }
});

test("project init also refuses over a manifest it cannot read", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".forge"));
    writeFileSync(f.manifest, "not json");
    expect(f.call(["project", "init"], 1)).toMatchObject({
      ok: false,
      error: { code: "PROJECT_MANIFEST_EXISTS" },
    });
    expect(readFileSync(f.manifest, "utf8")).toBe("not json");
  } finally {
    f.close();
  }
});

test("the init help says the id is never changed by init or config", () => {
  const f = fixture();
  try {
    const text = JSON.stringify(
      f.call(["catalog", "describe", "project.init"]),
    );
    expect(text).toContain("never overwrites");
    expect(text).toContain("owner");
  } finally {
    f.close();
  }
});
