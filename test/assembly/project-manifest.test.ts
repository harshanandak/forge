import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_MANIFEST,
  type ProjectManifest,
  initProjectManifest,
  readProjectManifest,
} from "../../src/assembly/project-manifest.ts";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = "5b0f3c1e-2a4d-4e8f-9a6b-7c1d2e3f4a5b";

function project(manifest?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "forge-project-manifest-"));
  if (manifest !== undefined) {
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, PROJECT_MANIFEST),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("a missing manifest reads as no manifest", () => {
  const p = project();
  try {
    expect(readProjectManifest(p.root)).toBeUndefined();
  } finally {
    p.close();
  }
}, 30_000);

test("a valid manifest reads back with and without a name", () => {
  const cases: ProjectManifest[] = [
    { schema: 1, id: ID },
    { schema: 1, id: ID, name: "demo-app" },
  ];
  for (const manifest of cases) {
    const p = project(manifest);
    try {
      expect(readProjectManifest(p.root)).toEqual(manifest);
    } finally {
      p.close();
    }
  }
}, 30_000);

test("an unknown field is refused, so nothing else can ride in the manifest", () => {
  for (const extra of [
    { token: "secret" },
    { path: "/home/someone/project" },
    { account: "owner@example.test" },
    { cloud: { url: "https://example.test" } },
  ]) {
    const p = project({ schema: 1, id: ID, ...extra });
    try {
      const field = Object.keys(extra)[0]!;
      expect(() => readProjectManifest(p.root)).toThrow(
        new RegExp(`unknown field.*${field}`),
      );
    } finally {
      p.close();
    }
  }
  const p = project('{"schema":1,"id":"' + ID + '","__proto__":{"x":1}}');
  try {
    expect(() => readProjectManifest(p.root)).toThrow(/unknown field/);
  } finally {
    p.close();
  }
}, 30_000);

test("a malformed manifest is refused with a message that names the file", () => {
  const bad: unknown[] = [
    "not json",
    "[]",
    "null",
    { id: ID },
    { schema: 2, id: ID },
    { schema: 1 },
    { schema: 1, id: "0123456789abcdef" },
    { schema: 1, id: ID.replace("-4e8f-", "-1e8f-") },
    { schema: 1, id: ID.toUpperCase() },
    { schema: 1, id: ID, name: "" },
    { schema: 1, id: ID, name: "has space" },
    { schema: 1, id: ID, name: "x".repeat(65) },
    { schema: 1, id: ID, name: 7 },
  ];
  for (const manifest of bad) {
    const p = project(manifest);
    try {
      expect(() => readProjectManifest(p.root)).toThrow(/project\.json/);
    } finally {
      p.close();
    }
  }
}, 30_000);

test("init writes a new random v4 id and nothing else", () => {
  const p = project();
  try {
    const made = initProjectManifest(p.root, "demo-app");
    expect(made.schema).toBe(1);
    expect(made.id).toMatch(V4);
    expect(made.name).toBe("demo-app");
    const text = readFileSync(join(p.root, PROJECT_MANIFEST), "utf8");
    expect(JSON.parse(text)).toEqual({
      schema: 1,
      id: made.id,
      name: "demo-app",
    });
    expect(readProjectManifest(p.root)).toEqual(made);
    const second = project();
    try {
      // The id is random: the folder name, remote and history never decide it.
      expect(initProjectManifest(second.root).id).not.toBe(made.id);
    } finally {
      second.close();
    }
  } finally {
    p.close();
  }
}, 30_000);

test("init refuses to overwrite any existing manifest and leaves its bytes alone", () => {
  for (const existing of [
    { schema: 1, id: ID },
    '{"schema":1,"id":"' + ID + '","token":"kept"}',
    "not json",
  ]) {
    const p = project(existing);
    const path = join(p.root, PROJECT_MANIFEST);
    const before = readFileSync(path);
    try {
      let thrown: unknown;
      try {
        initProjectManifest(p.root, "other");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        error: { code: "PROJECT_MANIFEST_EXISTS", retry: "never" },
      });
      expect(readFileSync(path).equals(before)).toBe(true);
    } finally {
      p.close();
    }
  }
}, 30_000);

test("init refuses a name that is not plain label characters", () => {
  const p = project();
  try {
    expect(() => initProjectManifest(p.root, "client name/secret")).toThrow(
      /name/,
    );
    expect(readProjectManifest(p.root)).toBeUndefined();
  } finally {
    p.close();
  }
}, 30_000);

function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("a symlinked manifest is one documented refusal, not an internal error", () => {
  const p = project();
  const target = mkdtempSync(join(tmpdir(), "forge-project-manifest-target-"));
  try {
    mkdirSync(join(p.root, ".forge"));
    // A directory link is a junction on Windows, which needs no privilege; any symlink is refused.
    symlinkSync(target, join(p.root, PROJECT_MANIFEST), "junction");
    for (const work of [
      () => readProjectManifest(p.root),
      () => initProjectManifest(p.root),
    ]) {
      const error = thrown(work) as {
        error?: { code: string; message: string };
      };
      expect(error.error?.code).toBe("PROJECT_MANIFEST_UNSAFE");
      expect(error.error?.message).toContain(".forge/project.json");
    }
  } finally {
    p.close();
    rmSync(target, { recursive: true, force: true });
  }
}, 30_000);

test("a directory where the manifest should be is the same refusal on every platform", () => {
  const p = project();
  try {
    mkdirSync(join(p.root, PROJECT_MANIFEST), { recursive: true });
    const error = thrown(() => readProjectManifest(p.root)) as {
      error?: { code: string; message: string };
    };
    expect(error.error?.code).toBe("PROJECT_MANIFEST_UNSAFE");
    expect(error.error?.message).toContain(".forge/project.json");
  } finally {
    p.close();
  }
}, 30_000);

test("an oversized manifest keeps its own size-limit error", () => {
  const p = project("x".repeat(5_000));
  try {
    const error = thrown(() => readProjectManifest(p.root)) as {
      error?: { code: string };
    };
    expect(error.error?.code).toBe("LIMIT_EXCEEDED");
  } finally {
    p.close();
  }
}, 30_000);

const posixTest = process.platform === "win32" ? test.skip : test;

// A FIFO with no writer blocks open() forever, and a blocked synchronous call cannot be timed out
// from inside the test, so each call runs in a child process that the test kills after 10 seconds.
posixTest(
  "a FIFO where the manifest should be is refused without blocking, on read, check and init",
  () => {
    const p = project();
    try {
      mkdirSync(join(p.root, ".forge"));
      expect(spawnSync("mkfifo", [join(p.root, PROJECT_MANIFEST)]).status).toBe(
        0,
      );
      const script =
        "import(process.env.FORGE_T_MODULE).then((m) => {" +
        " try { m[process.env.FORGE_T_CALL](process.env.FORGE_T_ROOT); console.log('none'); }" +
        " catch (e) { console.log(e.error?.code ?? 'other'); } });";
      for (const call of [
        "readProjectManifest",
        "projectManifestExists",
        "initProjectManifest",
      ]) {
        const run = spawnSync(process.execPath, ["-e", script], {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            FORGE_T_MODULE: new URL(
              "../../src/assembly/project-manifest.ts",
              import.meta.url,
            ).href,
            FORGE_T_CALL: call,
            FORGE_T_ROOT: p.root,
          },
        });
        expect(run.error).toBeUndefined();
        expect(run.stdout.trim()).toBe("PROJECT_MANIFEST_UNSAFE");
      }
    } finally {
      p.close();
    }
  },
  30_000,
);
