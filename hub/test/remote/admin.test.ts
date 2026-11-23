import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_PATTERNS } from "../../src/contract/errors.ts";
import { HOST_KEY_PATTERN, TOKEN_PATTERN } from "../../src/contract/ids.ts";
import { adminFixture } from "./admin-fixtures.ts";
import { config, digest, person } from "./fixtures.ts";

const timeout = 30_000;
const createArgs = (kind: string, path: string, id = person.personId) => [
  kind,
  "create",
  "--person",
  id,
  "--label",
  "laptop",
  "--output",
  path,
];

for (const kind of ["token", "host"]) {
  test(
    `K1-K2 ${kind} creation verifies parent, returns only id and path, and registers the digest`,
    async () => {
      const f = await adminFixture();
      const path = join(f.root, "credential");
      try {
        const result = await f.run(createArgs(kind, path));
        expect(result.status).toBe(0);
        const file = await readFile(path, "utf8");
        const secret =
          kind === "token"
            ? file.trimEnd().slice("FORGE_HUB_TOKEN=".length)
            : file.trimEnd();
        expect(secret).toMatch(
          kind === "token" ? TOKEN_PATTERN : HOST_KEY_PATTERN,
        );
        expect(file).toBe(
          (kind === "token" ? "FORGE_HUB_TOKEN=" : "") + secret + "\n",
        );
        expect(f.sizes).toEqual([0]);
        expect(f.checks[0]).toEqual([f.root, "dir"]);
        expect(f.core.calls.at(-1)).toEqual([
          kind === "token" ? "createToken" : "createHostKey",
          person.personId,
          "laptop",
          digest(secret),
        ]);
        expect(result.stdout.trim()).toBe(
          (kind === "token" ? "tok_new" : "hst_new") + " " + path,
        );
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain(digest(secret));
        for (const pattern of SECRET_PATTERNS)
          expect(result.stdout + result.stderr).not.toMatch(pattern);
      } finally {
        await f.close();
      }
    },
    timeout,
  );
}

test(
  "K3-K4 refuse existing files and both forms of git work tree",
  async () => {
    const f = await adminFixture();
    try {
      const existing = join(f.root, "existing");
      await writeFile(existing, "keep");
      expect((await f.run(createArgs("token", existing))).status).toBe(1);
      expect(await readFile(existing, "utf8")).toBe("keep");
      for (const kind of ["file", "dir"]) {
        const repo = join(f.root, kind);
        await mkdir(repo);
        if (kind === "file")
          await writeFile(join(repo, ".git"), "gitdir: fixture");
        else await mkdir(join(repo, ".git"));
        const path = join(repo, "secrets", "credential");
        expect((await f.run(createArgs("host", path))).status).toBe(1);
        expect(await f.exists(path)).toBe(false);
      }
      expect(f.core.calls).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "K5 and K10 private creation refusal writes nothing and a missing parent uses private creation",
  async () => {
    const f = await adminFixture();
    try {
      const direct = join(f.root, "direct");
      f.allowed = false;
      expect((await f.run(createArgs("token", direct))).status).toBe(1);
      expect(await f.exists(direct)).toBe(false);
      expect(f.sizes).toEqual([]);
      expect(f.core.calls).toEqual([]);
      f.allowed = true;
      f.fileAllowed = false;
      expect((await f.run(createArgs("host", direct))).status).toBe(1);
      expect(f.sizes).toEqual([0]);
      expect(await f.exists(direct)).toBe(false);
      expect(f.core.calls).toEqual([]);
      f.fileAllowed = true;
      const missing = join(f.root, "private");
      const nested = join(missing, "credential");
      expect(await f.exists(missing)).toBe(false);
      expect((await f.run(createArgs("host", nested))).status).toBe(0);
      expect(f.checks).toContainEqual([missing, "dir"]);
      expect(await f.exists(nested)).toBe(true);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "K6 disabled creation refuses before touching paths or core",
  async () => {
    const f = await adminFixture(
      config({ mcp: { enabled: false }, hooks: { enabled: false } }),
    );
    const path = join(f.root, "credential");
    try {
      for (const [kind, block] of [
        ["token", "mcp"],
        ["host", "hooks"],
      ]) {
        const result = await f.run(createArgs(kind ?? "", path));
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain(
          "BLOCK_DISABLED: " + block,
        );
      }
      expect(f.core.calls).toEqual([]);
      expect(f.checks).toEqual([]);
      expect(await f.exists(path)).toBe(false);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "K7 revoke stays available with blocks off and rejects a wrong id kind",
  async () => {
    const f = await adminFixture(
      config({ mcp: { enabled: false }, hooks: { enabled: false } }),
    );
    try {
      for (const [kind, id] of [
        ["token", "tok_a"],
        ["host", "hst_a"],
      ] as const) {
        expect(await f.run([kind, "revoke", id])).toMatchObject({
          status: 0,
          stdout: "revoked\n",
        });
        const unknown = await f.run([kind, "revoke", id]);
        expect(unknown.status).toBe(1);
        expect(unknown.stdout + unknown.stderr).toBe("not found\n");
      }
      const called = f.core.calls.length;
      expect((await f.run(["token", "revoke", person.personId])).status).toBe(
        2,
      );
      expect(f.core.calls).toHaveLength(called);
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "K8 unknown people and core refusals leave no file",
  async () => {
    const f = await adminFixture();
    try {
      const path = join(f.root, "credential");
      for (const id of ["per_nobody", person.personId]) {
        if (id === person.personId) f.core.createToken = () => undefined;
        const result = await f.run(createArgs("token", path, id));
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain("PERSON_UNKNOWN");
        expect(await f.exists(path)).toBe(false);
      }
    } finally {
      await f.close();
    }
  },
  timeout,
);

test(
  "K9 every invalid credential invocation prints the same usage line",
  async () => {
    const f = await adminFixture();
    try {
      let usage: string | undefined;
      for (const args of [
        [],
        ["unknown"],
        ["token", "create"],
        [...createArgs("host", join(f.root, "x")), "extra"],
      ]) {
        const result = await f.run(args);
        expect(result.status).toBe(2);
        const output = result.stdout + result.stderr;
        usage ??= output;
        expect(output).toBe(usage);
        expect(output.trim().split("\n")).toHaveLength(1);
      }
      expect(f.core.calls).toEqual([]);
    } finally {
      await f.close();
    }
  },
  timeout,
);
