import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_KEY_PATTERN, TOKEN_PATTERN } from "../../src/contract/ids.ts";
import { adminTest } from "./admin-fixtures.ts";
import { config, digest, person, safeOutput } from "./fixtures.ts";

const timeout = 30_000;
const check = adminTest(timeout);
const create = (kind: string, path: string, id = person.personId) => [
  kind,
  "create",
  "--person",
  id,
  "--label",
  "laptop",
  "--output",
  path,
];
const disabled = config({ mcp: { enabled: false }, hooks: { enabled: false } });
const commands = [
  [
    "token",
    "mcp",
    "tok_a",
    "tok_new",
    "createToken",
    TOKEN_PATTERN,
    "FORGE_HUB_TOKEN=",
  ],
  ["host", "hooks", "hst_a", "hst_new", "createHostKey", HOST_KEY_PATTERN, ""],
] as const;

for (const [kind, block, oldId, id, write, pattern, prefix] of commands) {
  check("K1-K2 protected file and digest only for " + kind, async (f) => {
    const path = f.path("credential");
    const result = await f.run(create(kind, path));
    expect(result.status).toBe(0);
    const file = await readFile(path, "utf8");
    const secret = file.trimEnd().slice(prefix.length);
    expect(secret).toMatch(pattern);
    expect(file).toBe(prefix + secret + "\n");
    expect(f.sizes).toEqual([0]);
    expect(f.checks[0]).toEqual([f.root, "dir"]);
    expect(f.core.calls.at(-1)).toEqual([
      write,
      person.personId,
      "laptop",
      digest(secret),
    ]);
    expect(result.stdout.trim()).toBe(id + " " + path);
    expect(result.stderr).toBe("");
    safeOutput(result.stdout + result.stderr, [digest(secret)]);
  });
  check(
    "K6 disabled creation for " + kind,
    async (f) => {
      const path = f.path("credential");
      const result = await f.run(create(kind, path));
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "BLOCK_DISABLED: " + block,
      );
      expect(f.core.calls).toEqual([]);
      expect(f.checks).toEqual([]);
      expect(await f.exists(path)).toBe(false);
    },
    disabled,
  );
  check(
    "K7 revoke with blocks off for " + kind,
    async (f) => {
      expect(await f.run([kind, "revoke", oldId])).toMatchObject({
        status: 0,
        stdout: "revoked\n",
      });
      const unknown = await f.run([kind, "revoke", oldId]);
      expect(unknown.status).toBe(1);
      expect(unknown.stdout + unknown.stderr).toBe("not found\n");
      const called = f.core.calls.length;
      expect((await f.run([kind, "revoke", person.personId])).status).toBe(2);
      expect(f.core.calls).toHaveLength(called);
    },
    disabled,
  );
}

check(
  "K3-K4 existing file and both git work tree markers refuse",
  async (f) => {
    const existing = f.path("existing");
    await writeFile(existing, "keep");
    expect((await f.run(create("token", existing))).status).toBe(1);
    expect(await readFile(existing, "utf8")).toBe("keep");
    for (const kind of ["file", "dir"]) {
      const repo = f.path(kind);
      await mkdir(repo);
      const git = join(repo, ".git");
      if (kind === "file") await writeFile(git, "gitdir: fixture");
      else await mkdir(git);
      const path = join(repo, "secrets", "credential");
      expect((await f.run(create("host", path))).status).toBe(1);
      expect(await f.exists(path)).toBe(false);
    }
    expect(f.core.calls).toEqual([]);
  },
);

check(
  "K5 and K10 refuse unsafe paths and privately create a missing parent",
  async (f) => {
    const direct = f.path("direct");
    f.state.allowed = false;
    expect((await f.run(create("token", direct))).status).toBe(1);
    expect(await f.exists(direct)).toBe(false);
    expect(f.sizes).toEqual([]);
    expect(f.core.calls).toEqual([]);
    f.state.allowed = true;
    f.state.fileAllowed = false;
    expect((await f.run(create("host", direct))).status).toBe(1);
    expect(f.sizes).toEqual([0]);
    expect(await f.exists(direct)).toBe(false);
    expect(f.core.calls).toEqual([]);
    f.state.fileAllowed = true;
    const missing = f.path("private");
    const nested = join(missing, "credential");
    expect(await f.exists(missing)).toBe(false);
    expect((await f.run(create("host", nested))).status).toBe(0);
    expect(f.checks).toContainEqual([missing, "dir"]);
    expect(await f.exists(nested)).toBe(true);
  },
);

check("K8 unknown person or registration refusal leaves no file", async (f) => {
  const path = f.path("credential");
  for (const id of ["per_nobody", person.personId]) {
    if (id === person.personId) f.core.createToken = () => undefined;
    const result = await f.run(create("token", path, id));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("PERSON_UNKNOWN");
    expect(await f.exists(path)).toBe(false);
  }
});

check("K9 invalid creation prints one fixed usage line", async (f) => {
  let usage: string | undefined;
  const cases = [
    [],
    ["unknown"],
    ["token", "create"],
    [...create("host", f.path("x")), "extra"],
  ];
  for (const args of cases) {
    const result = await f.run(args);
    expect(result.status).toBe(2);
    const output = result.stdout + result.stderr;
    usage ??= output;
    expect(output).toBe(usage);
    expect(output.trim().split("\n")).toHaveLength(1);
  }
  expect(f.core.calls).toEqual([]);
});
