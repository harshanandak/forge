// [integration] The installed CLI: cloud.login is discoverable and refuses unsafe states before any request.
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  credentialStore,
  openCloudFiles,
} from "../../src/assembly/cloud-profile.ts";
import type { ResultEnvelope } from "../../src/generated/types.ts";
import {
  bindingFor,
  entry,
  ORIGIN,
  OTHER_ORIGIN,
  PROJECT,
  PROJECT_ID,
  SECRET,
} from "./cloud-fixture.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "forge-cloud-cli-"));
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(join(root, ".forge"), { recursive: true });
  mkdirSync(home);
  // The block declares cloud.login, so the project enables it like any other first-party block.
  writeFileSync(
    join(root, ".forge", "config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { cloud: { source: { builtin: "forge/cloud" } } },
    }),
  );
  const run = (args: string[]) => {
    const result = spawnSync("node", [bin, ...args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FORGE_DEVICE_ROOT: join(dir, "device"),
        FORGE_DEVICE_ID: "cli-device-1",
        FORGE_SESSION: "cloud-login-test",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 40_000,
    });
    expect(result.error).toBeUndefined();
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return {
      envelope: JSON.parse(lines[0] ?? "") as ResultEnvelope,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return {
    root,
    home,
    binding: join(root, ".forge", "cloud.json"),
    credentials: join(home, ".forge", "cloud", "credentials.json"),
    manifest() {
      writeFileSync(
        join(root, ".forge", "project.json"),
        `${JSON.stringify({ schema: 1, id: PROJECT_ID })}\n`,
      );
    },
    run,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const code = (envelope: ResultEnvelope): string | undefined =>
  envelope.ok ? undefined : envelope.error.code;

test("cloud.login is listed and described for a person at the installed CLI", () => {
  const f = fixture();
  try {
    const list = f.run(["catalog", "list"]);
    expect(list.status).toBe(0);
    const entries = (list.envelope as { result: { op: string }[] }).result;
    expect(entries.map((c) => c.op)).toContain("cloud.login");
    const described = f.run([
      "catalog",
      "describe",
      "--input",
      '{"op":"cloud.login"}',
    ]);
    expect(described.status).toBe(0);
    expect(described.envelope).toMatchObject({
      ok: true,
      result: { op: "cloud.login", declaration: { callers: ["human"] } },
    });
  } finally {
    f.close();
  }
}, 60_000);

test("without a project identity login is a context failure and writes nothing", () => {
  const f = fixture();
  try {
    const out = f.run([
      "cloud",
      "login",
      "--origin",
      ORIGIN,
      "--project",
      PROJECT,
    ]);
    expect(out.status).toBe(6);
    expect(code(out.envelope)).toBe("CONTEXT_MISSING");
    expect(existsSync(f.binding)).toBe(false);
    expect(existsSync(join(f.home, ".forge"))).toBe(false);
  } finally {
    f.close();
  }
}, 60_000);

test("an input with a credential as a property name or value prints it nowhere", () => {
  const f = fixture();
  try {
    f.manifest();
    const name = `fct_0123456789abcdef.${SECRET}`;
    const value = `fct_fedcba9876543210.${"V".repeat(43)}`;
    for (const input of [{ [name]: value }, { origin: { [name]: value } }]) {
      const out = f.run(["cloud", "login", "--input", JSON.stringify(input)]);
      expect(out.status).toBe(6);
      expect(code(out.envelope)).toBe("INPUT_INVALID");
      const shown = out.stdout + out.stderr;
      for (const secret of [name, value, SECRET, "fct_"])
        expect(shown).not.toContain(secret);
      expect(existsSync(f.binding)).toBe(false);
      expect(existsSync(f.credentials)).toBe(false);
    }
  } finally {
    f.close();
  }
}, 60_000);

test("an http origin is refused before any request", () => {
  const f = fixture();
  try {
    f.manifest();
    const out = f.run([
      "cloud",
      "login",
      "--origin",
      "http://forge.example.test",
      "--project",
      PROJECT,
    ]);
    expect(out.status).toBe(6);
    expect(code(out.envelope)).toBe("INPUT_INVALID");
    expect(out.stderr).toBe("");
  } finally {
    f.close();
  }
}, 60_000);

test("a binding edited to another origin than the saved credential is refused with both files unchanged", async () => {
  const f = fixture();
  try {
    f.manifest();
    await credentialStore(openCloudFiles(f.home), {
      wait: () => Promise.resolve(),
    }).save(entry(Date.now()));
    writeFileSync(
      f.binding,
      `${JSON.stringify(bindingFor({ origin: OTHER_ORIGIN }), null, 2)}\n`,
    );
    const before = [
      readFileSync(f.credentials, "utf8"),
      readFileSync(f.binding, "utf8"),
    ];
    const out = f.run(["cloud", "login"]);
    expect(out.status).toBe(4);
    expect(code(out.envelope)).toBe("INPUT_CONFLICT");
    expect([
      readFileSync(f.credentials, "utf8"),
      readFileSync(f.binding, "utf8"),
    ]).toEqual(before);
    expect(out.stdout + out.stderr).not.toContain("fct_");
  } finally {
    f.close();
  }
}, 60_000);

test("an unreachable origin is unavailable, leaves no credential or binding, and prints no secret", () => {
  const f = fixture();
  try {
    f.manifest();
    const out = f.run([
      "cloud",
      "login",
      "--origin",
      "https://127.0.0.1:1",
      "--project",
      PROJECT,
    ]);
    expect(out.status).toBe(1);
    expect(code(out.envelope)).toBe("UNAVAILABLE");
    expect(existsSync(f.binding)).toBe(false);
    expect(existsSync(f.credentials)).toBe(false);
    expect(out.stdout + out.stderr).not.toContain("fct_");
    expect(out.stdout + out.stderr).not.toContain(SECRET);
  } finally {
    f.close();
  }
}, 60_000);
