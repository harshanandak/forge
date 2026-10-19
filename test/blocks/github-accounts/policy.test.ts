import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

setDefaultTimeout(1000);
async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

const source = () =>
  readFileSync(
    new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
    "utf8",
  );
async function message(
  policy: string,
  text: string,
  patterns = ["codex", "claude"],
) {
  const module = {
    exports: {} as Record<string, (args: unknown) => Promise<unknown>>,
  };
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(source()),
    {
      module,
      fail: (code: string, detail: string) => {
        throw Object.assign(new Error(detail), { code });
      },
    },
  );
  return await module.exports["github-account.message"]!({
    input: { text },
    config: { coauthorPolicy: policy, aiCoauthorPatterns: patterns },
  });
}
test("refuses AI trailers only in the trailer paragraph", async () => {
  await refused(
    message("refuse", "Change\n\nCo-Authored-By: Codex <bot@example.com>\n"),
    "AI_COAUTHOR_REFUSED",
  );
  expect(
    await message(
      "refuse",
      "Co-Authored-By: Codex <bot@example.com>\n\nThis is an example.\n",
    ),
  ).toEqual({
    text: "Co-Authored-By: Codex <bot@example.com>\n\nThis is an example.\n",
    changed: false,
  });
}, 1000);
test("strip preserves human coauthors and message text", async () => {
  expect(
    await message(
      "strip",
      "Change\n\nCo-authored-by: Human <human@example.com>\nCo-authored-by: Claude <bot@example.com>\n",
    ),
  ).toEqual({
    text: "Change\n\nCo-authored-by: Human <human@example.com>\n",
    changed: true,
  });
  expect(
    await message(
      "allow",
      "Change\n\nCo-authored-by: Codex <bot@example.com>\n",
    ),
  ).toEqual({
    text: "Change\n\nCo-authored-by: Codex <bot@example.com>\n",
    changed: false,
  });
}, 1000);
test("single-paragraph and folded trailers cannot evade refusal", async () => {
  await refused(
    message("refuse", "Co-authored-by: Codex <bot@example.com>\n"),
    "AI_COAUTHOR_REFUSED",
  );
  await refused(
    message(
      "refuse",
      "Change\r\n\r\nCo-authored-by: Tool\r\n Codex <bot@example.com>\r\n",
    ),
    "AI_COAUTHOR_REFUSED",
  );
  const body =
    "Change\n\nThis paragraph discusses a trailer.\nCo-authored-by: Codex <bot@example.com>\n";
  expect(await message("refuse", body)).toEqual({ text: body, changed: false });
}, 1000);
test("removing the AI detection makes the refusal counterfactual fail", async () => {
  const module = {
    exports: {} as Record<string, (args: unknown) => Promise<unknown>>,
  };
  const marker = 'group.key === "co-authored-by" &&';
  expect(source().includes(marker)).toBe(true);
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(
      source().replace(marker, "false &&"),
    ),
    {
      module,
      fail: (code: string) => {
        throw Object.assign(new Error(code), { code });
      },
    },
  );
  const result = await module.exports["github-account.message"]!({
    input: { text: "Change\n\nCo-authored-by: Codex <bot@example.com>\n" },
    config: { coauthorPolicy: "refuse", aiCoauthorPatterns: ["codex"] },
  });
  expect(result).toEqual({
    text: "Change\n\nCo-authored-by: Codex <bot@example.com>\n",
    changed: false,
  });
}, 1000);

test("message-file strips through an exact-content Git-area write and leaves unchanged files alone", () => {
  const module = { exports: {} as Record<string, (args: unknown) => unknown> };
  runInNewContext(
    new Bun.Transpiler({ loader: "ts" }).transformSync(source()),
    {
      module,
      fail: (code: string) => {
        throw Object.assign(new Error(code), { code });
      },
    },
  );
  const text = "Change\n\nCo-authored-by: Codex <bot@example.com>\n";
  const reads: unknown[] = [],
    writes: unknown[] = [];
  let current = text;
  const services = {
    process: {},
    repository: {},
    account: {},
    crypto: {},
    environment: { select: () => ({}) },
    files: {
      roots: { git: "/clone/.git" },
      read: (...args: unknown[]) => {
        reads.push(args);
        return current;
      },
      write: (...args: unknown[]) => {
        writes.push(args);
      },
    },
  };
  const config = {
    coauthorPolicy: "strip",
    aiCoauthorPatterns: ["codex"],
    environmentNames: [],
    maxFileBytes: 10000,
  };
  const call = () =>
    module.exports["github-account.message-file"]!({
      input: { path: "/clone/.git/COMMIT_EDITMSG" },
      config,
      services,
    });
  expect(call()).toEqual({ text: "Change\n", changed: true });
  expect(reads).toEqual([["COMMIT_EDITMSG", 10000, "git"]]);
  expect(writes).toEqual([
    ["COMMIT_EDITMSG", "Change\n", { area: "git", expected: text }],
  ]);
  current = "Change\n";
  expect(call()).toEqual({ text: current, changed: false });
  expect(writes).toHaveLength(1);
});
