import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { originRepositoryName } from "../../../src/adapters/vcs-git/index.ts";
import { idPrefix } from "../../../src/assembly/providers.ts";
import { fakeProcess } from "../../adapters/process/fake-process.ts";

setDefaultTimeout(30_000);

const root = mkdtempSync(join(tmpdir(), "forge-origin-prefix-"));
mkdirSync(join(root, ".git"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const options = { env: {}, timeoutMs: 1000, maxOutputBytes: 1000 };

test("a project name becomes an id prefix of lowercase letters, digits and single hyphens", () => {
  expect(idPrefix("forge")).toBe("forge");
  expect(idPrefix("Product-Suite")).toBe("product-suite");
  expect(idPrefix("My_Repo.v2")).toBe("my-repo-v2");
  expect(idPrefix("--scoreeasy--")).toBe("scoreeasy");
  expect(idPrefix("x".repeat(40))).toBe("x".repeat(32));
  expect(idPrefix("___")).toBeUndefined();
});

test.each([
  ["/repos/alpha/.git", "alpha", "alpha"],
  ["/repos/beta/.git/", "beta", "beta"],
  ["/repos/alpha/.git///", "alpha", "alpha"],
  ["../alpha/.git", "alpha", "alpha"],
  ["./alpha/.git/", "alpha", "alpha"],
  ["alpha/.git", "alpha", "alpha"],
  ["C:\\repos\\alpha\\.git", "alpha", "alpha"],
  ["C:\\repos\\alpha\\.git\\", "alpha", "alpha"],
  ["..\\alpha\\.git\\\\", "alpha", "alpha"],
  ["C:/repos/alpha\\.git/", "alpha", "alpha"],
  ["/repos/alpha.git", "alpha", "alpha"],
  ["../alpha.git/", "alpha", "alpha"],
  ["C:\\repos\\alpha.git\\", "alpha", "alpha"],
  ["https://example.invalid/o/Forge.git", "Forge", "forge"],
  ["https://example.invalid/o/Forge/", "Forge", "forge"],
  ["ssh://git@example.invalid:2222/o/Forge.git", "Forge", "forge"],
  ["git@example.invalid:o/Forge.git", "Forge", "forge"],
  ["/repos/alpha.git-backup", "alpha.git-backup", "alpha-git-backup"],
  ["/repos/.git-tools", ".git-tools", "git-tools"],
  ["/repos/alpha/.git-backup/", ".git-backup", "git-backup"],
  ["/repos/.git/alpha", "alpha", "alpha"],
  ["/repos/alpha.git/.git/", "alpha", "alpha"],
])(
  "origin %s supplies repository %s and prefix %s",
  async (origin, name, prefix) => {
    const process = fakeProcess(["git"], () => ({ stdout: `${origin}\n` }));
    const repository = await originRepositoryName(root, {
      ...options,
      process,
    });
    expect(repository).toBe(name);
    expect(idPrefix(repository ?? "")).toBe(prefix);
    expect(process.runs[0]?.args).toEqual([
      "config",
      "--get",
      "remote.origin.url",
    ]);
  },
);

test("unanswered origins remain unavailable and capacity errors propagate", async () => {
  for (const result of [
    { stdout: "" },
    { stdout: "/repos/alpha/.git", exitCode: 1 },
    { stdout: "/repos/alpha/.git", truncated: true },
    { exitCode: null, timedOut: true },
  ]) {
    expect(
      await originRepositoryName(root, {
        ...options,
        process: fakeProcess(["git"], () => result),
      }),
    ).toBeUndefined();
  }
  expect(
    await originRepositoryName(root, { ...options, process: fakeProcess([]) }),
  ).toBeUndefined();
  const spawnError = new Error("git cannot start");
  spawnError.name = "ProcessSpawnError";
  const capacityError = Object.assign(new Error("capacity exhausted"), {
    error: { code: "PROCESS_LIMIT_EXCEEDED" },
  });
  for (const error of [spawnError, capacityError]) {
    const read = originRepositoryName(root, {
      ...options,
      process: fakeProcess(["git"], () => {
        throw error;
      }),
    });
    if (error === spawnError) expect(await read).toBeUndefined();
    else await expect(read).rejects.toBe(capacityError);
  }
});
